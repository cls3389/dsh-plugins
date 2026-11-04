/**
 * @dsh-friends/ths-wencai — DSH Cordis adapter.
 *
 * 问财(iwencai)是独立筛选/检索域：本人登录准入，公共问题共享答案与账号池。
 * 与行情(public)和自选(10jqka 主站)完全分开。
 * 本插件只是薄壳：查询与扫码登录全部经 ths-data-hub，JS 零协议零状态。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityOf, principalKey } from '../feishu-principal/index.js';

// QR 目录跨平台契约(2026-11-05): POSIX 保持 /tmp/openclaw-ths-qr —— feishu_send_image 的
// isQr 规则 hard-match 这个前缀(baiying 扫码链路依赖)；win32 无 feishu-channel，走 os.tmpdir()。
const QR_DIR = process.platform === 'win32' ? join(tmpdir(), 'openclaw-ths-qr') : '/tmp/openclaw-ths-qr';

const name = 'ths-wencai';
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	dataHubBaseUrl: '',
	dataHubToken: '',
	dataHubTokenFile: '',
	dataHubTimeoutMs: 20000,
	// 身份簇默认应用：飞书用户 u_xxx 归属解析用。
	defaultAppId: '',
};

function readToken(direct, file) {
	const token = String(direct ?? '').trim();
	if (token) return token;
	if (!file) return '';
	try { return fs.readFileSync(file, 'utf8').trim(); }
	catch { return ''; }
}

function hubToken(cfg) {
	return readToken(cfg.dataHubToken, cfg.dataHubTokenFile);
}

function resolveUserId(exec, cfg) {
	const identity = identityOf(exec?.agent);
	const openId = exec?.agent?.larkUser?.openId ?? identity?.subjectId;
	if (typeof openId !== 'string' || !openId.startsWith('ou_')) return null; // Web owner
	const appId = exec?.agent?.larkUser?.appId ?? identity?.appId;
	return principalKey(openId, appId, cfg.defaultAppId || appId);
}

/** 问财登录二维码路径必须命中 feishu_send_image 的 isQr 规则（POSIX 契约路径，见 QR_DIR 注释）。 */
function qrImagePath() {
	const hex = crypto.randomBytes(8).toString('hex');
	return `${QR_DIR}/qr-${hex}.png`;
}

async function saveQrImage(buffer) {
	const path = qrImagePath();
	await fs.promises.mkdir(QR_DIR, { recursive: true, mode: 0o700 });
	await fs.promises.writeFile(path, buffer, { mode: 0o600 });
	return path;
}

/** 唯一请求路径：问财域全部经数据中心。 */
async function hubCall(exec, cfg, method, path, options = {}) {
	const base = String(cfg.dataHubBaseUrl ?? '').replace(/\/+$/, '');
	if (!base) throw new Error('dataHubBaseUrl 未配置');
	const headers = {
		'X-API-Key': hubToken(cfg),
		...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
	};
	const userId = resolveUserId(exec, cfg);
	if (userId) headers['X-THS-User-Id'] = userId;
	const url = new URL(base + path);
	for (const [k, v] of Object.entries(options.query ?? {})) {
		if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.dataHubTimeoutMs ?? 20000);
	try {
		const response = await fetch(url, {
			method, headers,
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			signal: controller.signal,
		});
		if (options.binary) {
			if (!response.ok) throw new Error(`数据中心 HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		}
		const text = await response.text();
		let parsed;
		try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
		if (!response.ok) {
			const message = parsed?.error ?? parsed?.message ?? `数据中心 HTTP ${response.status}`;
			const err = new Error(String(message));
			// 401 = 该用户还没有问财登录态：调用方据此引导扫码，而不是报系统故障。
			err.needsLogin = response.status === 401;
			throw err;
		}
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}

function errorText(err) {
	if (err?.needsLogin) {
		return `${err.message}——请对当前用户发起问财扫码登录：ths_wencai_qr_login(action="create")，扫码确认后重试。`;
	}
	return err?.message ?? String(err);
}

const anyJsonOutput = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => {
		const text = JSON.stringify(value, null, 1);
		return [{ type: 'text', text: text.length > 20000 ? `${text.slice(0, 20000)}\n…(已截断,共 ${text.length} 字符)` : text }];
	},
};

function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	const register = (def) => ctx.tools.register({ ...def, output: def.output ?? anyJsonOutput });

	// ── ths_wencai：自然语言选股（问财域） ──
	register({
		name: 'ths_wencai',
		description: '问财自然语言条件选股与信息检索：用于复杂条件筛选、题材和涨停原因等汇总，例如“今日涨停且量比大于2的股票，并附涨停原因”。价格、涨跌幅、成交量额、K线、盘口和市场统计优先使用行情工具；行情明确不覆盖或缺少字段时才用本工具补充，AI摘要须核对日期、市场、单位和来源。请求者必须先登录自己的问财账号；公共问题由中心共享答案缓存并轮询可用账号池，个人问题仅用本人账号。限额与短期限频分别处理；登录失效用 ths_wencai_qr_login 重新登录。',
		parameters: {
			type: 'object',
			properties: {
				condition: { type: 'string', description: '完整的自然语言筛选条件或信息检索问题；涉及时间时明确日期/交易日，避免将常规行情取数转到本工具' },
				limit: { type: 'integer', description: '每张结果表的行数上限，默认20；不裁剪answer分析，也不代表总匹配证券数。以returned_row_count/available_row_count及limit_scope核对返回范围' },
			},
			required: ['condition'],
		},
		async execute(args, exec) {
			try {
				const data = await hubCall(exec, cfg, 'POST', '/api/tools/market/ths_wencai', {
					body: { arguments: { condition: args.condition, limit: args.limit } },
				});
				return data.data ?? data;
			} catch (err) { return { error: errorText(err) }; }
		},
	});

	// ── ths_wencai_qr_login：问财扫码登录（独立于自选登录） ──
	register({
		name: 'ths_wencai_qr_login',
		description: '当前用户的问财账号扫码登录或重新登录，独立于自选股登录和证券交易连接。action=create 返回二维码图片，飞书中用 feishu_send_image 发送后结束本轮；中心自动轮询并保存登录态。action=check 仅在需要时查询一次，不反复轮询。本人有效问财登录是共享池的使用资格。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				action: { type: 'string', enum: ['create', 'check'], description: 'create=生成二维码；check=查一次状态' },
				qrid: { type: 'string', description: 'action=check 时必填' },
			},
			required: ['action'],
		},
		async execute(args, exec) {
			try {
				if (args.action === 'create') {
					const created = await hubCall(exec, cfg, 'POST', '/api/login/start?channel=wencai', { body: {} });
					const qrid = created.data?.qrid ?? created.qrid;
					const img = await hubCall(exec, cfg, 'GET', '/api/login/qrimg', { query: { qrid }, binary: true });
					const savePath = await saveQrImage(img);
					return {
						status: 'ok', action: 'create', channel: 'wencai', qrid, output: savePath, media: savePath,
						mediaUrls: [savePath], trustedLocalMedia: true,
						message: `问财登录二维码已生成，请立即把图片发送给用户（有效期约 120 秒）。图片路径：${savePath}`,
						instructions: `只调用一次 feishu_send_image(path=${JSON.stringify(savePath)}) 发送二维码，然后结束本轮。中心自动轮询，用户扫完手机确认即可，无需再回复。`,
					};
				}
				if (args.action === 'check') {
					if (!args.qrid) return { error: '缺少 qrid 参数' };
					const data = await hubCall(exec, cfg, 'GET', '/api/login/poll', { query: { qrid: args.qrid } });
					const state = data.data?.state ?? data.state;
					if (state === 'done') return { status: 'ok', action: 'check', message: '问财扫码登录成功，登录态已保存到数据中心' };
					if (state === 'error') return { error: `问财登录失败: ${data.data?.error ?? data.error ?? '未知错误'}` };
					return { status: 'pending', action: 'check', state, message: '尚未确认，等待用户在手机上确认登录' };
				}
				return { error: 'action 必须是 create 或 check' };
			} catch (err) { return { error: errorText(err) }; }
		},
	});
}

export { apply, inject, name, qrImagePath };
