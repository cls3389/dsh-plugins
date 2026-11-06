/** Route watch notifications through the owning channel's durable reply queue.
 * The channel resolves its persisted chat binding and checks app/user/session
 * ownership before accepting a notification. A raw agent.followup bypasses the
 * channel reply lifecycle and must never be used as a delivery fallback.
 */
/** Permanent rejections: the data center drops the event instead of retrying.
 * Transient failures (e.g. notification service not ready) stay retryable and
 * must keep the default 500 status.
 */
function rejected(message) {
	const error = new Error(message);
	error.permanent = true;
	return error;
}

async function deliverWatchWake(ctx, _cfg, rule, text, sessionId, eventId) {
	const targetSessionId = sessionId ?? rule?.sessionId;
	if (!rule?.id || !rule.ownerOpenId || !rule.ownerAppId) {
		throw rejected('盯盘提醒缺少规则或用户/应用归属，已拒绝投递');
	}
	if (typeof targetSessionId !== 'string' || !targetSessionId) {
		throw rejected('盯盘提醒缺少归属会话，已拒绝投递');
	}
	if (sessionId && rule.sessionId && sessionId !== rule.sessionId) {
		throw rejected('盯盘提醒会话与规则归属不一致，已拒绝投递');
	}
	if (typeof eventId !== 'string' || !eventId || typeof text !== 'string' || !text.trim()) {
		throw rejected('盯盘提醒缺少稳定事件 ID 或正文，已拒绝投递');
	}
	const notifications = ctx.get('feishuNotifications');
	if (typeof notifications?.deliver !== 'function') {
		throw new Error('飞书后台通知服务未就绪，提醒保留在数据中心等待重试');
	}
	await notifications.deliver({
		sessionId: targetSessionId,
		ownerOpenId: rule.ownerOpenId,
		ownerAppId: rule.ownerAppId,
		text,
		eventId: `ths-watch-${eventId}`,
		immediateAlert: true,
	});
}

export { deliverWatchWake };
