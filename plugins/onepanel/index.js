/**
 * @dsh-friends/onepanel — 1Panel 管理面板 API 工具插件(多服务器)
 *
 * 认证:Header `1Panel-Token: md5("1panel"+apiKey+timestamp)` + `1Panel-Timestamp`(秒)。
 *      v1 老面板公式不同(md5(key+timestamp)),插件自动探测并按服务器缓存。
 * 多服务器:config.servers[] 列表(name/baseUrl/apiKey[/apiBase][/requestTimeoutMs]);
 *          所有工具带可选 server 参数,默认第一台。1Panel v1 服务器(apiBase=/api/v1)
 *          仅 onepanel_api 透传可用,专用工具会明确报错。
 * 面板地址:host:port 直连(公网端口可达即用,无需域名安全入口/ask 门)。
 *      API key 的 IP 白名单:多段用换行分隔,逗号无效(v2 实测)。
 *
 * 工具:
 *   onepanel_status     宿主机实时状态(CPU/内存/负载/IO)
 *   onepanel_containers 列出/搜索 Docker 容器
 *   onepanel_container  容器操作(启停重启)与日志
 *   onepanel_apps       列出已安装应用(含可升级)
 *   onepanel_app        应用操作(start/stop/restart/upgrade/sync...)
 *   onepanel_cronjobs   列出/搜索计划任务
 *   onepanel_cronjob    计划任务:执行/启停/修改/记录
 *   onepanel_api        通用调用兜底(任何 /api/* 接口)
 *
 * 已知适配点(v2):
 *   - cronjobs/update DTO 要求 timeout>=1(历史行 0=无限);update 时对 0 强制抬 3600。
 *   - 修改 spec 应同时 specCustom=true,否则面板执行周期列把 `1-5` 显示成"每周 X:XX"错位。
 *   - records 的 startTime/endTime 用 RFC3339;容器日志走 download/log 返纯文本。
 */

import crypto from 'node:crypto';

const name = 'onepanel';
const inject = ['tools'];

const CONFIG_DEFAULTS = {
	baseUrl: process.env.ONEPANEL_BASE_URL || 'http://172.18.0.1:8090',
	apiKey: process.env.ONEPANEL_API_KEY || '',
	requestTimeoutMs: 15000,
	servers: [],
	// serversFile: 服务器列表 JSON 文件路径(热读,按 mtime 缓存);增删服务器改文件即可,无需重启宿主。
	// 文件格式: {"servers":[{name,baseUrl,apiKey,apiBase?,requestTimeoutMs?}]}
	serversFile: '',
};

function renderJson(value, budget = 6000) {
	let text;
	try {
		text = JSON.stringify(value, null, 1);
	} catch {
		text = String(value);
	}
	if (text.length > budget) text = `${text.slice(0, budget)}\n…(截断,共 ${text.length} 字符)`;
	return { type: 'text', text };
}

const anyJsonOutput = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => [renderJson(value)],
};

// 宿主对工具返回值做 lossless JSON 校验:值为 undefined 的键会整包报错
// "value is not lossless JSON"。所有 execute 返回前统一深清洗(丢 undefined 键)。
function clean(v, depth = 0) {
	if (depth > 12) return null;
	if (v === undefined) return null;
	if (v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
	const out = {};
	for (const k of Object.keys(v)) {
		const x = v[k];
		if (x !== undefined) out[k] = clean(x, depth + 1);
	}
	return out;
}

import fs from 'node:fs';

function apply(ctx, config) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	// 注册时包一层:execute 返回值先过 clean,再交框架
	const register = (tool) =>
		ctx.tools.register({
			...tool,
			execute: async (args, actx) => clean(await tool.execute(args, actx)),
		});

	/* ── 服务器注册表(支持 serversFile 热读) ─────── */
	const servers = [];
	const authPrefixCache = new Map(); // baseUrl|apiKey -> 已探测公式,热重载后保留
	function normalizeServer(s, fallbackTimeout) {
		if (!s?.baseUrl || !s?.apiKey) {
			ctx.logger.warn(`onepanel: servers 项缺 baseUrl/apiKey,跳过 ${s?.name ?? '(unnamed)'}`);
			return null;
		}
		const key = `${s.baseUrl}|${s.apiKey}`;
		return {
			name: s.name || s.baseUrl,
			baseUrl: String(s.baseUrl).replace(/\/+$/, ''),
			apiKey: s.apiKey,
			apiBase: s.apiBase || '/api/v2',
			requestTimeoutMs: s.requestTimeoutMs || fallbackTimeout,
			authPrefix: authPrefixCache.get(key) ?? null,
		};
	}
	function loadServers() {
		const list = [];
		if (cfg.serversFile) {
			try {
				const st = fs.statSync(cfg.serversFile);
				if (serversFileMtime === null || st.mtimeMs !== serversFileMtime) {
					serversFileCache = JSON.parse(fs.readFileSync(cfg.serversFile, 'utf8'));
					serversFileMtime = st.mtimeMs;
					ctx.logger.info(`onepanel: serversFile 重载(${(serversFileCache.servers ?? []).length} 台)`);
				}
			} catch (err) {
				ctx.logger.warn(`onepanel: serversFile 读取失败(${err.message}),沿用上次缓存`);
			}
			for (const s of serversFileCache?.servers ?? []) {
				const n = normalizeServer(s, cfg.requestTimeoutMs);
				if (n) list.push(n);
			}
			if (list.length) return list;
		}
		if (Array.isArray(cfg.servers) && cfg.servers.length) {
			for (const s of cfg.servers) {
				const n = normalizeServer(s, cfg.requestTimeoutMs);
				if (n) list.push(n);
			}
		} else if (cfg.apiKey) {
			list.push({
				name: 'default',
				baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
				apiKey: cfg.apiKey,
				apiBase: '/api/v2',
				requestTimeoutMs: cfg.requestTimeoutMs,
				authPrefix: 'v2',
			});
		}
		return list;
	}
	let serversFileMtime = null;
	let serversFileCache = null;

	function currentServers() {
		const list = loadServers();
		for (const s of list) {
			if (s.authPrefix !== null) authPrefixCache.set(`${s.baseUrl}|${s.apiKey}`, s.authPrefix);
		}
		return list;
	}

	// serverParam 描述为静态快照(注册时生成);pickServer 每次调用都热读,以后加的服务器也能用
	const bootServers = currentServers();
	if (!bootServers.length) ctx.logger.warn('onepanel: 未配置任何服务器(serversFile/servers[]/baseUrl+apiKey),工具不可用');
	const serverParam = {
		type: 'string',
		description: `目标服务器名,默认第一台(${bootServers[0]?.name ?? '无'});已配置:${bootServers.map((s) => s.name).join('/') || '无'};完整列表以 serversFile 热读为准`,
	};

	function pickServer(name) {
		const servers = currentServers();
		if (!servers.length) throw new Error('onepanel: 未配置任何服务器');
		if (!name) return servers[0];
		const s = servers.find((x) => x.name === name);
		if (!s) throw new Error(`未知服务器 ${name}(可用: ${servers.map((x) => x.name).join('/')})`);
		return s;
	}

	function requireV2(server, toolName) {
		if (server.apiBase !== '/api/v2') {
			throw new Error(`${toolName} 仅支持 1Panel v2;服务器 ${server.name} 是 ${server.apiBase}(v1 老面板),请用 onepanel_api 透传,或把面板升级到 v2`);
		}
	}

	function tokenFor(server, ts) {
		const prefix = server.authPrefix === 'v1' ? '' : '1panel';
		return crypto.createHash('md5').update(`${prefix}${server.apiKey}${ts}`).digest('hex');
	}

	async function rawRequest(server, method, url, body) {
		const ts = Math.floor(Date.now() / 1000).toString();
		try {
			return await fetch(url, {
				method,
				headers: {
					'1Panel-Token': tokenFor(server, ts),
					'1Panel-Timestamp': ts,
					...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
					Accept: 'application/json',
				},
				...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
				signal: AbortSignal.timeout(server.requestTimeoutMs),
			});
		} catch (err) {
			throw new Error(`1Panel[${server.name}] ${url.replace(server.baseUrl, '')} 连接失败: ${err.message}`);
		}
	}

	async function readJson(server, res, url) {
		try {
			return await res.json();
		} catch {
			throw new Error(`1Panel[${server.name}] ${url.replace(server.baseUrl, '')}: HTTP ${res.status}(非 JSON 响应)`);
		}
	}

	// call:JSON 信封;401 密钥无效时按 v1 公式重试一次(自动探测,按服务器缓存)
	async function call(server, relPath, body, method = 'POST') {
		if (!server) throw new Error('onepanel: 未配置服务器');
		const url = `${server.baseUrl}${server.apiBase}/${relPath}`;
		let res = await rawRequest(server, method, url, body);
		let json = await readJson(server, res, url);
		const keyInvalid = res.status === 401 && /key|token|密钥/i.test(json.message ?? '');
		if (keyInvalid && server.authPrefix === null) {
			server.authPrefix = 'v1';
			res = await rawRequest(server, method, url, body);
			json = await readJson(server, res, url);
		}
		if (json.code !== 200) throw new Error(`1Panel[${server.name}] ${server.apiBase}/${relPath} 失败: HTTP ${json.code} ${json.message ?? ''}`);
		return json.data ?? {};
	}

	async function callRaw(server, method, relPath, body) {
		const url = `${server.baseUrl}${server.apiBase}/${relPath}`;
		const res = await rawRequest(server, method, url, body);
		if (!res.ok) throw new Error(`1Panel[${server.name}] ${server.apiBase}/${relPath}: HTTP ${res.status}`);
		return res.text();
	}

	/* ── 状态 ─────────────────────────────────────── */

	register({
		name: 'onepanel_status',
		description: '指定服务器的宿主机实时状态:CPU/内存/负载/运行时长/进程数/磁盘与网络 IO。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				ioOption: { type: 'string', enum: ['Enable', 'Disable'], description: '磁盘 IO 统计,默认 Enable' },
				netOption: { type: 'string', enum: ['Enable', 'Disable'], description: '网络 IO 统计,默认 Enable' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_status');
			const d = await call(s, `dashboard/current/${args.ioOption ?? 'Enable'}/${args.netOption ?? 'Enable'}`, {}, 'GET');
			// v2 dashboard 字段是扁平的(memoryTotal/memoryUsed/... 平铺,无嵌套 memory/disk 对象)
			return {
				server: s.name,
				uptime: d.timeSinceUptime,
				runningTime: d.runningTime,
				procs: d.procs,
				load: { load1: d.load1, load5: d.load5, load15: d.load15, usagePercent: d.loadUsagePercent },
				cpu: {
					usedPercent: d.cpuUsedPercent ?? d.cpuPercent,
					totalCores: d.cpuTotal,
					perCorePercent: d.cpuDetailedPercent ?? d.cpuPercent,
				},
				memory: {
					total: d.memory?.total ?? d.memoryTotal,
					used: d.memory?.used ?? d.memoryUsed,
					available: d.memory?.available ?? d.memoryAvailable,
					usedPercent: d.memory?.usedPercent ?? d.memoryUsedPercent,
				},
				swap: {
					total: d.swap?.total ?? d.swapMemoryTotal,
					used: d.swap?.used ?? d.swapMemoryUsed,
				},
				disk: d.disk ?? d.diskData,
				io: {
					readBytes: d.ioStats?.readBytes ?? d.ioReadBytes,
					writeBytes: d.ioStats?.writeBytes ?? d.ioWriteBytes,
					count: d.ioCount,
				},
				net: {
					sentBytes: d.netStats?.sentBytes ?? d.netBytesSent,
					recvBytes: d.netStats?.recvBytes ?? d.netBytesRecv,
				},
				topCPUItems: d.topCPUItems,
				topMemItems: d.topMemItems,
			};
		},
	});

	/* ── 容器 ─────────────────────────────────────── */

	register({
		name: 'onepanel_containers',
		description: '指定服务器的 Docker 容器列表/搜索(名称、状态、镜像、运行时长、网络、端口、所属应用)。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				name: { type: 'string', description: '可选,按容器名模糊过滤' },
				state: { type: 'string', enum: ['all', 'running', 'exited'], description: '默认 all' },
				pageSize: { type: 'integer', description: '默认 50' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_containers');
			const data = await call(s, 'containers/search', {
				page: 1,
				pageSize: args.pageSize ?? 50,
				name: args.name ?? '',
				state: args.state ?? 'all',
				orderBy: 'createdAt',
				order: 'null',
				filters: '',
			});
			const items = (data.items ?? []).map((it) => ({
				name: it.name,
				state: it.state,
				imageName: it.imageName,
				runTime: it.runTime,
				network: it.network,
				ports: it.ports,
				appName: it.appName || it.appInstallName || undefined,
				createTime: it.createTime,
			}));
			return { server: s.name, total: data.total ?? items.length, items };
		},
	});

	register({
		name: 'onepanel_container',
		description:
			'指定服务器的容器操作。action=operate 启停等(operation: start|stop|restart|kill|pause|unpause,remove 谨慎);action=logs 查日志(默认 tail 100 行,带时间戳)。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				action: { type: 'string', enum: ['operate', 'logs'], description: '操作类型' },
				names: { type: 'array', items: { type: 'string' }, description: 'action=operate:容器名列表' },
				operation: { type: 'string', enum: ['start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'remove'], description: 'action=operate 时必填;remove 删容器不删卷' },
				container: { type: 'string', description: 'action=logs:容器名' },
				tail: { type: 'integer', description: 'action=logs:尾部行数,默认 100' },
				since: { type: 'string', description: 'action=logs:起始时间(如 2026-10-28 18:00:00),可选' },
			},
			required: ['action'],
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_container');
			if (args.action === 'operate') {
				if (!args.names?.length || !args.operation) throw new Error('action=operate 需要 names + operation');
				await call(s, 'containers/operate', { names: args.names, operation: args.operation });
				return { server: s.name, ok: true, operation: args.operation, names: args.names };
			}
			if (!args.container) throw new Error('action=logs 需要 container');
			const text = await callRaw(s, 'POST', 'containers/download/log', {
				containerType: 'container',
				container: args.container,
				tail: args.tail ?? 100,
				since: args.since ?? '',
				timestamp: true,
			});
			return { server: s.name, container: args.container, log: text.length > 12000 ? `${text.slice(-12000)}\n…(已截断,保留末尾)` : text };
		},
	});

	/* ── 应用商店 ─────────────────────────────────── */

	register({
		name: 'onepanel_apps',
		description: '指定服务器的 1Panel 已安装应用(版本/运行状态/可升级标记/端口/安装路径)。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				name: { type: 'string', description: '可选,按应用名模糊过滤' },
				update: { type: 'boolean', description: '只看有可用更新的,默认 false' },
				pageSize: { type: 'integer', description: '默认 50' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_apps');
			const data = await call(s, 'apps/installed/search', {
				page: 1,
				pageSize: args.pageSize ?? 50,
				name: args.name ?? '',
				tags: [],
				update: args.update ?? false,
				unused: false,
				orderBy: 'name',
				order: 'null',
				groupID: 0,
			});
			const items = (data.items ?? []).map((it) => ({
				id: it.id,
				name: it.name,
				appName: it.appName,
				version: it.version,
				status: it.status,
				message: it.message || undefined,
				canUpdate: it.canUpdate,
				httpPort: it.httpPort || undefined,
				path: it.path,
			}));
			return { server: s.name, total: data.total ?? items.length, items };
		},
	});

	register({
		name: 'onepanel_app',
		description:
			'操作指定服务器的已安装应用(installId 见 onepanel_apps)。operate: start|stop|restart|sync|rebuild|reload|upgrade(升级耗时会后台执行);delete 谨慎(forceDelete=true 才删应用目录)。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				installId: { type: 'integer', description: '应用安装 ID' },
				operate: { type: 'string', enum: ['start', 'stop', 'restart', 'sync', 'rebuild', 'reload', 'upgrade', 'delete'], description: '操作类型' },
				forceDelete: { type: 'boolean', description: 'operate=delete 时删除应用目录,默认 false(不删)' },
			},
			required: ['installId', 'operate'],
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_app');
			await call(s, 'apps/installed/op', {
				installId: args.installId,
				operate: args.operate,
				forceDelete: args.forceDelete ?? false,
			});
			return { server: s.name, ok: true, installId: args.installId, operate: args.operate };
		},
	});

	/* ── 计划任务 ─────────────────────────────────── */

	register({
		name: 'onepanel_cronjobs',
		description: '指定服务器的计划任务列表(执行周期、状态、上次执行)。改过 spec 的任务应确保 specCustom=true,否则面板显示错位。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				info: { type: 'string', description: '可选,按任务名称模糊过滤' },
				pageSize: { type: 'integer', description: '默认 50' },
			},
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_cronjobs');
			const data = await call(s, 'cronjobs/search', {
				page: 1,
				pageSize: args.pageSize ?? 50,
				info: args.info ?? '',
				groupIDs: [],
				orderBy: 'createdAt',
				order: 'null',
			});
			const items = (data.items ?? []).map((it) => ({
				id: it.id,
				name: it.name,
				type: it.type,
				spec: it.spec,
				specCustom: it.specCustom,
				status: it.status,
				script: it.script || undefined,
				user: it.user,
				lastRecordStatus: it.lastRecordStatus,
				lastRecordTime: it.lastRecordTime,
			}));
			return { server: s.name, total: data.total ?? items.length, items };
		},
	});

	register({
		name: 'onepanel_cronjob',
		description:
			'管理指定服务器的单个计划任务。action=execute 手动执行;status 启停;update 修改(只传要改的字段,改 spec 务必带 specCustom=true);records 查执行记录(含失败 stderr)。update 后 agent 端立即生效,无需重启。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				action: { type: 'string', enum: ['execute', 'status', 'update', 'records'], description: '操作类型' },
				id: { type: 'integer', description: '任务 ID(onepanel_cronjobs 可查)' },
				status: { type: 'string', enum: ['enable', 'disable'], description: 'action=status 时必填' },
				spec: { type: 'string', description: 'action=update:新 cron 表达式(如 "55 13 * * 1-5")' },
				specCustom: { type: 'boolean', description: 'action=update:改 spec 时必须 true' },
				name: { type: 'string', description: 'action=update:新名称' },
				script: { type: 'string', description: 'action=update:脚本路径(scriptMode=custom)' },
				user: { type: 'string', description: 'action=update:执行用户' },
				retainCopies: { type: 'integer', description: 'action=update:报告保留份数' },
				records: { type: 'integer', description: 'action=records:返回条数,默认 10' },
				statusFilter: { type: 'string', enum: ['Success', 'Failed', 'Waiting'], description: 'action=records:按状态过滤' },
			},
			required: ['action', 'id'],
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			requireV2(s, 'onepanel_cronjob');
			switch (args.action) {
				case 'execute': {
					await call(s, 'cronjobs/handle', { id: args.id });
					return { server: s.name, ok: true, id: args.id, executed: true };
				}
				case 'status': {
					if (!args.status) throw new Error('action=status 需要 status(enable|disable)');
					const st = args.status === 'enable' ? 'Enable' : 'Disable';
					await call(s, 'cronjobs/status', { id: args.id, status: st });
					return { server: s.name, ok: true, id: args.id, status: st };
				}
				case 'update': {
					const cur = await call(s, 'cronjobs/load/info', { id: args.id });
					const payload = {
						...cur,
						...(args.name ? { name: args.name } : {}),
						...(args.spec ? { spec: args.spec } : {}),
						...(args.specCustom !== undefined ? { specCustom: args.specCustom } : {}),
						...(args.script ? { script: args.script } : {}),
						...(args.user ? { user: args.user } : {}),
						...(args.retainCopies ? { retainCopies: args.retainCopies } : {}),
						alertCount: cur.alertCount ?? 0,
						alertTitle: cur.alertTitle ?? '',
						alertMethod: cur.alertMethod ?? '',
						alertTriggerMode: cur.alertTriggerMode ?? '',
						retryTimes: cur.retryTimes ?? 0,
						ignoreErr: cur.ignoreErr ?? false,
						secret: cur.secret ?? '',
						args: cur.args ?? '',
					};
					// DTO 要求 timeout>=1;历史行 0=无限,抬到 1 小时
					if (!payload.timeout || payload.timeout < 1) payload.timeout = 3600;
					if (!payload.retainCopies || payload.retainCopies < 1) payload.retainCopies = 7;
					await call(s, 'cronjobs/update', payload);
					const after = await call(s, 'cronjobs/load/info', { id: args.id });
					return {
						server: s.name,
						ok: true,
						id: args.id,
						updated: {
							name: after.name,
							spec: after.spec,
							specCustom: after.specCustom,
							script: after.script,
							user: after.user,
							timeout: after.timeout,
						},
					};
				}
				case 'records': {
					const data = await call(s, 'cronjobs/search/records', {
						page: 1,
						pageSize: args.records ?? 10,
						cronjobID: args.id,
						startTime: '2020-01-01T00:00:00+08:00',
						endTime: '2030-12-31T23:59:59+08:00',
						status: args.statusFilter ?? '',
					});
					const items = (data.items ?? []).map((r) => ({
						id: r.id,
						status: r.status,
						startTime: r.startTime,
						intervalMs: r.interval,
						message: (r.message || '').slice(0, 300),
					}));
					return { server: s.name, total: data.total ?? items.length, items };
				}
				default:
					throw new Error(`未知 action: ${args.action}`);
			}
		},
	});

	/* ── 通用兜底 ─────────────────────────────────── */

	register({
		name: 'onepanel_api',
		description:
			'1Panel API 通用调用(默认 POST)。path 以 /api/v1/ 或 /api/v2/ 开头则原样使用(用于 v1 老面板),否则按服务器 apiBase 拼接。接口清单见面板 swagger。写操作请谨慎,删改类先确认 ID。',
		parameters: {
			type: 'object',
			properties: {
				server: serverParam,
				path: { type: 'string', description: 'API 路径,如 cronjobs/search(自动拼 apiBase)或 /api/v1/cronjobs(原样)' },
				body: { type: 'object', description: '请求体对象,默认 {}' },
				method: { type: 'string', enum: ['POST', 'GET'], description: '默认 POST' },
			},
			required: ['path'],
		},
		output: anyJsonOutput,
		async execute(args) {
			const s = pickServer(args.server);
			const rel = args.path.startsWith('/api/') ? args.path.replace(/^\/api\/(v1|v2)\//, '') : args.path.replace(/^\/+/, '');
			const data = await call(s, rel, args.body ?? {}, args.method ?? 'POST');
			return data && Object.keys(data).length ? { server: s.name, data } : { server: s.name, ok: true };
		},
	});
}

export { apply, inject, name };
