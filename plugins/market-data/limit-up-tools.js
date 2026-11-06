/** The only public price-limit pool Agent tool. Provider selection, exact-code
 * explanation enrichment and same-source calculations belong to ths-data-hub. */
const limitUpTools = [
  {
    name: 'mkt_limit_up_pool',
    description: '涨跌停池与涨停复盘唯一工具，无需问财或另调原因工具。kind=limit_up(默认)/broken/limit_down/yesterday_limit_up；date 仅支持最新交易日（东财公共池不提供历史；其他日期返回 status=no_data 并附最新可用 supportedDate，不要重试其他日期）。默认 detail=summary 返回全池同源统计、封板率/首板/连板占比、完整东财行业计数及占比、领涨和题材示例；kind=limit_up 附 resealed 汇总与逐股回封标记（涨停池内炸板次数≥1=炸板后回封；炸板池口径=收盘仍未回封，勿跨池手算）。查某只股票传精确六位 code；查某行业传东财原生 industry（东财部分行业名被截断，如"汽车零部"；未命中时 selection.suggestions 返回正确名称，按建议重试一次即可）；按涨停原因关键词查传 reason 子串（如"机器人"，仅 kind=limit_up）。传筛选参数时直接返回匹配明细与子集连板/成交/封单汇总，不要 detail=full 或手抄到 bash 再筛选计算。selection.matchCount=0 表示不在该池/无匹配，不是上游无数据；count/total 始终指全池。只有明确要完整全池明细或题材全量股票时才 detail=full。东财名单与统计、同花顺原因按同代码补充，北交所原因缺失不混算；金额万元、时间北京时间。status=no_data 不等于0家，完整性/上游失败显式报错。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['limit_up', 'broken', 'limit_down', 'yesterday_limit_up'], description: '池类型：涨停/炸板/跌停/昨日涨停，默认 limit_up' },
        date: { type: 'string', pattern: '^\\d{8}$', description: '可选 YYYYMMDD，仅最新交易日有数据；省略为北京时间今天' },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary(默认)：统计+领涨+题材；full：完整标准化明细；传 code/industry/reason 时自动只返回目标子集' },
        code: { type: 'string', pattern: '^\\d{6}$', description: '可选精确证券代码，查单股时直接传，与 industry/reason 三选一' },
        industry: { type: 'string', minLength: 1, maxLength: 64, description: '可选东财原生行业名（未命中会返回 suggestions 正确名称），与 code/reason 三选一' },
        reason: { type: 'string', minLength: 1, maxLength: 64, description: '可选涨停原因关键词子串（如"机器人"），仅 kind=limit_up，与 code/industry 三选一' },
      },
    },
  },
];

function limitUpPoolOutput(args, value) {
  const text = JSON.stringify(value, null, 1);
  const budget = Math.max(12000, Math.min(90000, (value?.count ?? 0) * 450 + 5000));
  return [{ type: 'text', text: text.length > budget ? `${text.slice(0, budget)}\n…(输出异常超长已截断;count=${value?.count ?? 'unknown'})` : text }];
}

export { limitUpTools, limitUpPoolOutput };
