/**
 * @dsh-friends/feishu-keeper — feishu profile 进程保活插件
 *
 * 背景:
 *   dsh --profile feishu 是一个独立的 node 后台进程(setsid 启动,日志重定向到
 *   文件)。它不受任何进程管理器托管,容器每次重启(面板操作 / 镜像升级 /
 *   compose 变更)都会把它杀掉,且无人自动拉起 → "飞书不理我了"。
 *
 * 本插件装在 web/主 profile(容器主进程),激活时:
 *   1. 若检测到 feishu 进程已在运行(手动启动的存量进程),不干预,只做周期巡检;
 *   2. 若进程缺失,spawn 一个新的 feishu 子进程(继承本插件的 stdio 重定向到日志文件);
 *   3. 子进程意外退出时,按 backoff 自动重启(10s 起步,上限 5 分钟);
 *   4. 巡检周期 60s,防止 spawn 竞态造成双实例;检测到非本插件托管的实例时让位。
 *
 * 可移植默认值:所有路径从 DSH_HOME(缺省 ~/.dsh)与 HOME 推导,不绑定任何
 * 特定机器;bin 默认取宿主进程自身的 dsh 入口(process.argv[1]),无法识别时
 * 回退 PATH 上的 `dsh`。全部可用 profile config 覆盖。
 *
 * 安全边界:
 *   - 只管理 `dsh --profile <profile>` 一个命令,不执行任何外部输入;
 *   - 停用插件(config.enabled=false)或 web 主进程退出时,托管子进程一并终止,
 *     但手动启动的存量进程不受影响。
 */

import { spawn } from 'node:child_process';
import { openSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const name = 'feishu-keeper';
// 不 inject 任何服务:纯进程托管,避免阻塞加载。
const inject = [];

// 宿主进程就是 dsh 本体:argv[1] 即 dsh 入口脚本(任何安装方式都成立);
// 识别失败(非标准启动方式)回退 PATH 上的 `dsh` 命令。
const defaultDshBin = /dsh(?:-[0-9a-zA-Z._-]+)?[\\/]lib[\\/]bin\.(?:js|mjs|cjs)$/i.test(process.argv[1] ?? '') ? process.argv[1] : 'dsh';
const defaultDshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

const CONFIG_DEFAULTS = {
	/** 是否启用保活 */
	enabled: true,
	/** 巡检间隔(毫秒) */
	intervalMs: 60_000,
	/** 子进程崩溃后重启 backoff 起步(毫秒) */
	restartBackoffMs: 10_000,
	/** backoff 上限(毫秒) */
	restartBackoffMaxMs: 300_000,
	/** dsh 入口:默认宿主进程自己的入口脚本;或 PATH 上的 `dsh` */
	bin: defaultDshBin,
	/** 要保活的 profile 名 */
	profile: 'feishu',
	/** 子进程运行日志 / 退出轨迹 / keeper 自身日志(默认都在 DSH_HOME 下) */
	logFile: join(defaultDshHome, 'feishu-lark.log'),
	exitFile: join(defaultDshHome, 'feishu-process.exit'),
	keeperLog: join(defaultDshHome, 'feishu-keeper.log'),
	/** 子进程环境 */
	home: process.env.HOME ?? homedir(),
	dshHome: defaultDshHome,
};

function nowIso() {
	return new Date().toISOString();
}

function logLine(cfg, msg) {
	try {
		appendFileSync(cfg.keeperLog, `[${nowIso()}] [feishu-keeper] ${msg}\n`);
	} catch {
		// 日志写不进就算了,不让保活挂掉
	}
}

/** 扫描 /proc 找 node 跑目标 profile 的进程(排除自己 spawn 的);非 Linux 无 /proc 时返回 0。 */
async function findFeishuPid(excludePid, profile) {
	const { readdir } = await import('node:fs/promises');
	let entries;
	try {
		entries = await readdir('/proc');
	} catch {
		return 0;
	}
	for (const ent of entries) {
		if (!/^\d+$/.test(ent)) continue;
		const pid = Number(ent);
		if (pid === excludePid) continue;
		let raw;
		try {
			raw = await import('node:fs').then((m) => m.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
		} catch {
			continue; // 进程消失,正常竞态
		}
		const cmd = raw.split('\0').filter(Boolean).join(' ');
		// dsh 入口脚本或 dsh 命令 + --profile <profile>(排除 bash -c 探针之类)
		if (cmd.includes(`--profile ${profile}`) && /(?:bin\.(?:js|mjs|cjs))|(?:^|\/)dsh(?:\s|$)/.test(cmd) && !cmd.startsWith('bash')) {
			return pid;
		}
	}
	return 0;
}

export async function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...(config ?? {}) };
	if (cfg.enabled === false) {
		ctx.logger.info('[feishu-keeper] disabled by config');
		return;
	}

	let child = null; // 本插件托管的子进程
	let childPid = 0;
	let backoff = cfg.restartBackoffMs;
	let stopping = false;
	let timer = null;

	const logFd = openSync(cfg.logFile, 'a');

	function writeExitFile(line) {
		try {
			appendFileSync(cfg.exitFile, `${line}\n`);
		} catch {}
	}

	function spawnManaged(reason) {
		if (stopping) return;
		logLine(cfg, `spawning feishu profile (${reason})`);
		writeExitFile(`keeper_spawn started=${nowIso()} reason=${reason}`);
		// bin 是 .js 入口 → 用当前 node 跑;否则(如 PATH 上的 `dsh`)直接执行
		const viaNode = /\.(?:js|mjs|cjs)$/i.test(cfg.bin);
		child = viaNode
			? spawn(process.execPath, [cfg.bin, `--profile`, cfg.profile], {
				env: { ...process.env, HOME: cfg.home, DSH_HOME: cfg.dshHome },
				stdio: ['ignore', logFd, logFd],
				detached: false,
				cwd: cfg.home,
			})
			: spawn(cfg.bin, [`--profile`, cfg.profile], {
				env: { ...process.env, HOME: cfg.home, DSH_HOME: cfg.dshHome },
				stdio: ['ignore', logFd, logFd],
				detached: false,
				cwd: cfg.home,
			});
		childPid = child.pid;
		logLine(cfg, `spawned pid=${childPid}`);
		child.on('exit', (code, signal) => {
			writeExitFile(`keeper_child pid=${childPid} exit=${code ?? signal} ended=${nowIso()}`);
			if (stopping) return;
			// 崩溃/被杀 → backoff 重启
			logLine(cfg, `child pid=${childPid} exited (code=${code ?? signal}), restart in ${backoff}ms`);
			const wait = backoff;
			backoff = Math.min(backoff * 2, cfg.restartBackoffMaxMs);
			setTimeout(() => {
				// 重启前再探一次:可能 keeper 之外有人手动拉起了
				ensureRunning(`restart-after-exit`).catch(() => {});
			}, wait);
			child = null;
			childPid = 0;
		});
	}

	async function ensureRunning(reason) {
		if (stopping) return;
		if (child && child.exitCode === null) return; // 自己的还活着
		const external = await findFeishuPid(process.pid, cfg.profile);
		if (external) {
			// 有别人(手动/旧 wrapper)的实例在跑,让位不重复起
			child = null;
			childPid = 0;
			backoff = cfg.restartBackoffMs;
			return;
		}
		spawnManaged(reason);
	}

	timer = setInterval(() => {
		ensureRunning('patrol').catch((e) => logLine(cfg, `patrol error: ${e}`));
	}, cfg.intervalMs);
	timer.unref?.();

	await ensureRunning('plugin-activate');
	ctx.logger.info('[feishu-keeper] active: feishu profile supervised');

	return () => {
		stopping = true;
		if (timer) clearInterval(timer);
		if (child) {
			logLine(cfg, `plugin dispose: terminating managed child pid=${childPid}`);
			try {
				child.kill('SIGTERM');
			} catch {}
		}
		try {
			closeSync(logFd);
		} catch {}
	};
}
