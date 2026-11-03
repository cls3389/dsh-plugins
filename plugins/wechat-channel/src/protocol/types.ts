export interface WeixinMessage {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: { title?: string; message_item?: MessageItem; svr_id?: string };
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

export interface QRCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QRStatusResponse {
  status?:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect';
  errmsg?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WeixinInboundEvent {
  readonly messageId: string;
  readonly accountId: string;
  readonly subjectId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly contextToken?: string;
  readonly timestamp?: number;
  readonly groupId?: string;
  readonly raw: WeixinMessage;
}

export interface WeixinAccount {
  readonly accountId: string;
  readonly botId: string;
  readonly token: string;
  readonly baseUrl: string;
  readonly userId?: string;
}

export interface ILinkClientOptions {
  readonly account: WeixinAccount;
  readonly appClientVersion?: number;
  readonly requestTimeoutMs?: number;
  readonly longPollTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface UpdateBatch {
  readonly messages: readonly WeixinInboundEvent[];
  readonly nextCursor: string;
  readonly longPollTimeoutMs?: number;
}

export interface SendTextInput {
  readonly to: string;
  readonly text: string;
  readonly contextToken?: string;
  readonly runId?: string;
}

export interface SendTextResult {
  readonly clientId: string;
  readonly serverMessageId?: string;
}

export const MessageType = { BOT: 2 } as const;
export const MessageItemType = { TEXT: 1 } as const;
export const MessageState = { FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;
