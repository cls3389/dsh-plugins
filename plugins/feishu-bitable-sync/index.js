/**
 * @dsh-friends/feishu-bitable-sync —— 行情批量同步飞书多维表（fuyao-feishu-sync 的 DSH 插件重写版）。
 *
 * 数据源：FQGate V2（个股/指数快照、历史K线）+ 同花顺数据中心（问财富字段涨停池、
 * 涨跌分布、交易日历）——不再依赖任何 FQGate V1 端点。
 * 写入：飞书自建应用 tenant 凭据（需 bitable:app 权限 + 多维表协作者）。
 *
 * 三张表：标的跟踪（现价/涨跌幅/5·10·20日涨跌）、每日情绪总览、涨停明细（涨停+炸板）。
 * 触发：交易时段定时器（可配）+ 工具手动（dry_run / force / 指定日期回填）。
 */
import { BitableClient } from './feishu-bitable.js';
import { FqgateClient, DataCenterClient } from './data-sources.js';
import { SyncEngine, shanghaiDate } from './sync-engine.js';
import { createScheduler } from './scheduler.js';

export const name = 'feishu-bitable-sync';
export const inject = ['tools'];

const DEFAULTS = {
  fqgateBaseUrl: 'http://192.168.5.111:18000',
  dataCenterBaseUrl: 'http://127.0.0.1:17890',
  dataCenterApiKey: '',
  appId: '',
  appSecret: '',
  appToken: '',
  holdingsTableId: '',
  overviewTableId: '',
  detailTableId: '',
  codeField: '证券代码',
  fieldMap: {
    lastPrice: '现价', changeRatio: '涨跌幅',
    change5d: '5日涨跌', change10d: '10日涨跌', change20d: '20日涨跌',
  },
  sentimentIndexCodes: { 上证: '000001.SH', 深证: '399001.SZ', 创业板: '399006.SZ', 科创50: '000688.SH' },
  schedulerEnabled: false,
  dailyRunAt: '15:30',
  intradayEnabled: true,
  intradayIntervalMinutes: 5,
  batchDelayMs: 300,
  stateDir: '/data/dsh/storages/feishu-bitable-sync',
  requestTimeoutMs: 20000,
};

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config };
  const logger = ctx.logger ?? console;
  const anyJsonOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const text = JSON.stringify(value, null, 1);
      return [{ type: 'text', text: text.length > 20000 ? `${text.slice(0, 20000)}\n…(已截断,共 ${text.length} 字符)` : text }];
    },
  };

  const buildEngine = () => new SyncEngine({
    cfg,
    bitable: new BitableClient({
      appId: cfg.appId, appSecret: cfg.appSecret, appToken: cfg.appToken,
      logger, timeoutMs: cfg.requestTimeoutMs,
    }),
    fqgate: new FqgateClient({ baseUrl: cfg.fqgateBaseUrl, logger, timeoutMs: cfg.requestTimeoutMs }),
    dc: new DataCenterClient({ baseUrl: cfg.dataCenterBaseUrl, apiKey: cfg.dataCenterApiKey, logger }),
    logger,
  });

  ctx.tools.register({
    name: 'feishu_bitable_sync',
    label: '同步行情到多维表',
    description:
      '手动触发多维表行情同步（标的跟踪/每日情绪总览/涨停明细三张表）。默认同步今天；非交易日自动跳过（force 可强制）。' +
      'dry_run=true 只生成计划不写入；date=YYYY-MM-DD 回填历史交易日；scope=holdings|sentiment 只同步对应部分。' +
      '同步 175 个标的约需 1 分钟。定时任务开启时（schedulerEnabled）交易日 15:30 自动全量、盘中每 5 分钟自动同步。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dry_run: { type: 'boolean', description: '只生成更新计划不写入，默认 false' },
        force: { type: 'boolean', description: '非交易日也强制执行，默认 false' },
        date: { type: 'string', description: '指定交易日 YYYY-MM-DD（历史回填），默认今天' },
        intraday: { type: 'boolean', description: '盘中模式（临时价不入收盘缓存），默认 false' },
        scope: { type: 'string', description: 'holdings=只同步标的跟踪表；sentiment=只同步情绪/涨停明细表；缺省=全部' },
      },
    },
    output: anyJsonOutput,
    async execute(args) {
      const scope = args?.scope === 'holdings' ? 'holdingsOnly' : args?.scope === 'sentiment' ? 'overviewOnly' : null;
      const engine = buildEngine();
      const result = await engine.runAll({
        dryRun: Boolean(args?.dry_run),
        force: Boolean(args?.force),
        date: args?.date ?? null,
        intraday: Boolean(args?.intraday),
        ...(scope ? { [scope]: true } : {}),
      });
      return result;
    },
  });

  ctx.tools.register({
    name: 'feishu_bitable_sync_status',
    label: '多维表同步状态',
    description: '查看多维表行情同步的上次运行结果与调度器状态（上次时间/日期/各表增删改计数）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: anyJsonOutput,
    async execute() {
      const engine = buildEngine();
      const { readFile } = await import('node:fs/promises');
      let status = null;
      try { status = JSON.parse(await readFile(`${cfg.stateDir}/status.json`, 'utf8')); } catch { /* 尚无运行记录 */ }
      return {
        ok: true,
        schedulerEnabled: cfg.schedulerEnabled,
        dailyRunAt: cfg.dailyRunAt,
        intraday: cfg.intradayEnabled ? `每 ${cfg.intradayIntervalMinutes} 分钟` : '关闭',
        tables: {
          holdings: cfg.holdingsTableId || '未配置',
          overview: cfg.overviewTableId || '未配置',
          detail: cfg.detailTableId || '未配置',
        },
        lastRun: status?.lastRun ?? status ?? null,
        today: shanghaiDate(),
      };
    },
  });

  // 定时器：只应在单一身份开启（schedulerEnabled 默认 false）
  if (cfg.schedulerEnabled && cfg.appId && cfg.appSecret && cfg.appToken) {
    const engine = buildEngine();
    const scheduler = createScheduler({
      engine, logger,
      dailyRunAt: cfg.dailyRunAt,
      intradayEnabled: cfg.intradayEnabled,
      intradayIntervalMinutes: cfg.intradayIntervalMinutes,
    });
    ctx.effect(() => {
      scheduler.start();
      return () => scheduler.stop();
    });
  } else if (cfg.schedulerEnabled) {
    logger.warn?.('[bitable-sync] schedulerEnabled 但缺少飞书凭据/appToken，定时器未启动');
  }
}
