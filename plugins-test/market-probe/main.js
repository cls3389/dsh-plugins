/**
 * @dsh-friends/market-probe — 市场安装链路实测探针。
 * 唯一职责:作为一个合法的 dsh bundle 被 pnpm 拉取、被 loader 挂载。
 * 不注册任何工具/服务副作用,apply 只打一行日志。
 */
export const inject = [];

export function apply(ctx) {
	ctx.logger?.info?.('[market-probe] 探针已挂载(市场安装链路 OK)');
}
