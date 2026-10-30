/** Minimal config shape consumed by the official Lark implementation. */
export interface LarkRuntimeConfig {
  readonly channels: {
    readonly feishu: Record<string, unknown>;
  };
}
