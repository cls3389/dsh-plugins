/**
 * @dsh-friends/dsh-keeper — dsh profile 进程保活插件(多 profile)
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

const name = 'dsh-keeper';
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
	/** 要保活的 profile 列表(2026-10-30 拆分后默认三件套;单 profile 字段仍兼容) */
	profiles: ['owner', 'companion', 'guests'],
	/** 按 profile 派生日志文件(单 profile 字段 logFile/exitFile 兼容旧配置) */
	logFileFor: (profile) => join(defaultDshHome, `${profile.replace(/^feishu-?(?!$)/, '')}-lark.log`),
	exitFileFor: (profile) => join(defaultDshHome, `${profile.replace(/^feishu-?(?!$)/, '')}-process.exit`),
	/** 子进程环境 */
	home: process.env.HOME ?? homedir(),
	dshHome: defaultDshHome,
};

function nowIso() {
	return new Date().toISOString();
}

function logLine(cfg, msg) {
	try {
		appendFileSync(cfg.keeperLog, `[${nowIso()}] [dsh-keeper] ${msg}\n`);
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
		ctx.logger.info('[dsh-keeper] disabled by config');
		return;
	}
	// 多 profile 兼容:旧配置的 profile 单值归入 profiles 列表。
	const profiles = Array.isArray(cfg.profiles) && cfg.profiles.length
		? cfg.profiles
		: (cfg.profile ? [cfg.profile] : CONFIG_DEFAULTS.profiles);

	// 每 profile 一份守护状态(日志/退出文件按 profile 派生;旧 logFile/exitFile 单值兼容)。
	const states = profiles.map((profile) => ({
		profile,
		child: null,
		childPid: 0,
		backoff: cfg.restartBackoffMs,
		logFd: openSync(cfg.logFileFor ? cfg.logFileFor(profile) : cfg.logFile, 'a'),
		exitFile: cfg.exitFileFor ? cfg.exitFileFor(profile) : cfg.exitFile,
	}));

	let stopping = false;
	let timer = null;

	function logLineFor(state, msg) {
		try {
			appendFileSync(cfg.keeperLog, `[${nowIso()}] [dsh-keeper:${state.profile}] ${msg}\n`);
		} catch {}
	}

	function writeExitFile(state, line) {
		try {
			appendFileSync(state.exitFile, `${line}\n`);
		} catch {}
	}

	function spawnManaged(state, reason) {
		if (stopping) return;
		logLineFor(state, `spawning (${reason})`);
		writeExitFile(state, `keeper_spawn started=${nowIso()} reason=${reason}`);
		// bin 是 .js 入口 → 用当前 node 跑;否则(如 PATH 上的 `dsh`)直接执行
		const viaNode = /\.(?:js|mjs|cjs)$/i.test(cfg.bin);
		state.child = viaNode
			? spawn(process.execPath, [cfg.bin, `--profile`, state.profile], {
				env: { ...process.env, HOME: cfg.home, DSH_HOME: cfg.dshHome },
				stdio: ['ignore', state.logFd, state.logFd],
				detached: false,
				cwd: cfg.home,
			})
			: spawn(cfg.bin, [`--profile`, state.profile], {
				env: { ...process.env, HOME: cfg.home, DSH_HOME: cfg.dshHome },
				stdio: ['ignore', state.logFd, state.logFd],
				detached: false,
				cwd: cfg.home,
			});
		state.childPid = state.child.pid;
		logLineFor(state, `spawned pid=${state.childPid}`);
		state.child.on('exit', (code, signal) => {
			writeExitFile(state, `keeper_child pid=${state.childPid} exit=${code ?? signal} ended=${nowIso()}`);
			if (stopping) return;
			logLineFor(state, `pid=${state.childPid} exited (code=${code ?? signal}), restart in ${state.backoff}ms`);
			const wait = state.backoff;
			state.backoff = Math.min(state.backoff * 2, cfg.restartBackoffMaxMs);
			setTimeout(() => {
				ensureRunning(state, 'restart-after-exit').catch(() => {});
			}, wait);
			state.child = null;
			state.childPid = 0;
		});
	}

	async function ensureRunning(state, reason) {
		if (stopping) return;
		if (state.child && state.child.exitCode === null) return;
		const external = await findFeishuPid(process.pid, state.profile);
		if (external) {
			// 有别人(systemd/手动)的实例在跑,让位不重复起
			state.child = null;
			state.childPid = 0;
			state.backoff = cfg.restartBackoffMs;
			return;
		}
		spawnManaged(state, reason);
	}

	timer = setInterval(() => {
		for (const state of states) ensureRunning(state, 'patrol').catch((e) => logLineFor(state, `patrol error: ${e}`));
	}, cfg.intervalMs);
	timer.unref?.();

	for (const state of states) await ensureRunning(state, 'plugin-activate');
	ctx.logger.info(`[dsh-keeper] active: profiles [${profiles.join(', ')}] supervised`);

	return () => {
		stopping = true;
		if (timer) clearInterval(timer);
		for (const state of states) {
			if (state.child) {
				logLineFor(state, `plugin dispose: terminating managed child pid=${state.childPid}`);
				try {
					state.child.kill('SIGTERM');
				} catch {}
			}
			try {
				closeSync(state.logFd);
			} catch {}
		}
	};
}
