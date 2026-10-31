/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu / Lark SDK client management.
 *
 * Provides `LarkClient` — a unified manager for Lark SDK client instances,
 * WebSocket connections, EventDispatcher lifecycle, and bot identity.
 *
 * Consumers obtain instances via factory methods:
 *   - `LarkClient.fromCfg(cfg, accountId)` — resolve account from config
 *   - `LarkClient.fromAccount(account)` — from a pre-resolved account
 *   - `LarkClient.fromCredentials(credentials)` — ephemeral instance (not cached)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Lark from '@larksuiteoapi/node-sdk';

import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import type { MessageDedup } from '../messaging/inbound/dedup';
import { clearUserNameCache } from '../messaging/inbound/user-name-cache-store';
import type { FeishuProbeResult, LarkAccount, LarkBrand } from './types';
import { getLarkAccount } from './accounts';
import { clearChatInfoCache, injectLarkClient } from './chat-info-cache';
import { larkLogger } from './lark-logger';
import { getLarkRuntime, setLarkRuntime } from './runtime-store';
import { getUserAgent } from './version';

const log = larkLogger('core/lark-client');

// ---------------------------------------------------------------------------
// Inject User-Agent into all Feishu SDK requests
// ---------------------------------------------------------------------------

const GLOBAL_LARK_USER_AGENT_KEY = 'LARK_USER_AGENT';

function installGlobalUserAgent(): void {
  // node-sdk's built-in interceptor reads global.LARK_USER_AGENT to override User-Agent
  (globalThis as Record<string, unknown>)[GLOBAL_LARK_USER_AGENT_KEY] = getUserAgent();
}

installGlobalUserAgent();
// Disable axios auto-proxy to prevent HTTP_PROXY env vars from corrupting request URLs.
// Proxy routing is managed centrally by OpenClaw core's global-agent.
(Lark.defaultHttpInstance.defaults as Record<string, unknown>).proxy = false;
Lark.defaultHttpInstance.interceptors.request.handlers = [];
// Inject User-Agent header into all HTTP requests via interceptor
Lark.defaultHttpInstance.interceptors.request.use(
  (req) => {
    if (req.headers) {
      req.headers['User-Agent'] = getUserAgent();
    }
    return req;
  },
  undefined,
  { synchronous: true },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Credential set accepted by the ephemeral `fromCredentials` factory. */
export interface LarkClientCredentials {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  brand?: LarkBrand;
}

// ---------------------------------------------------------------------------
// Brand → SDK domain
// ---------------------------------------------------------------------------

const BRAND_TO_DOMAIN: Record<string, Lark.Domain> = {
  feishu: Lark.Domain.Feishu,
  lark: Lark.Domain.Lark,
};

/** Map a `LarkBrand` to the SDK `domain` parameter. */
function resolveBrand(brand: LarkBrand | undefined): Lark.Domain | string {
  return BRAND_TO_DOMAIN[brand ?? 'feishu'] ?? brand!.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// LarkClient
// ---------------------------------------------------------------------------

/** Instance cache keyed by accountId. */
const cache = new Map<string, LarkClient>();

/**
 * Compare two SecretRef-shaped objects by their identity fields.
 * Key-order independent, unlike JSON.stringify.
 */
function secretRefsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.source === b.source && a.provider === b.provider && a.id === b.id;
}

/**
 * Compare two credential values that may be strings or SecretRef objects.
 *
 * - Both strings: direct `===`.
 * - Both SecretRef objects: compare `source`, `provider`, `id` explicitly.
 * - Mixed (string vs SecretRef): treat as equal — the platform resolves the
 *   SecretRef at startup (producing the cached string) but `loadConfig()`
 *   returns the raw object on subsequent calls.  Detecting SecretRef identity
 *   changes is not useful here because the platform does not re-resolve
 *   feishu secrets on reload, so a new SecretRef would be equally unusable.
 */
function credentialsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return secretRefsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
  }
  // Mixed types: keep the cached instance that holds the working string.
  if ((typeof a === 'string' && b && typeof b === 'object') || (typeof b === 'string' && a && typeof a === 'object')) {
    return true;
  }
  return false;
}

export class LarkClient {
  readonly account: LarkAccount;

  private _sdk: Lark.Client | null = null;
  private _wsClient: Lark.WSClient | null = null;
  private _botOpenId: string | undefined;
  private _botName: string | undefined;
  private _lastProbeResult: FeishuProbeResult | null = null;
  private _lastProbeAt = 0;
  private _wsStopped = false;
  private _wsWatchdog: NodeJS.Timeout | null = null;
  private _wsReconnecting: Promise<void> | null = null;
  private _wsBackoffMs = 5000;
  private _wsHandlers: Record<string, (data: unknown) => Promise<void>> | null = null;
  private _wsAbortSignal: AbortSignal | undefined;

  private _wsReconnectDelayMs = 5000;
  private _wsConnectionGeneration = 0;

  /** Attached message deduplicator — disposed together with the client. */
  messageDedup: MessageDedup | null = null;

  // ---- Plugin runtime (singleton) ------------------------------------------

  /** Persist the runtime instance for later retrieval (activate 阶段调用一次). */
  static setRuntime(runtime: PluginRuntime): void {
    setLarkRuntime(runtime);
  }

  /** Retrieve the stored runtime instance. Throws if not yet initialised. */
  static get runtime(): PluginRuntime {
    return getLarkRuntime();
  }

  // ---- Global config (singleton) -------------------------------------------
  //
  // Plugin commands receive an account-scoped config (channels.feishu replaced
  // with the merged per-account config, `accounts` map stripped).  Commands
  // that need cross-account visibility (e.g. doctor, diagnose) read the
  // original global config from here.

  private static _globalConfig: ClawdbotConfig | null = null;

  /** Store the original global config (called during monitor startup). */
  static setGlobalConfig(cfg: ClawdbotConfig): void {
    LarkClient._globalConfig = cfg;
  }

  /** Retrieve the stored global config, or `null` if not yet set. */
  static get globalConfig(): ClawdbotConfig | null {
    return LarkClient._globalConfig;
  }

  // --------------------------------------------------------------------------

  private constructor(account: LarkAccount, private readonly wsFactory?: (params: any) => Lark.WSClient) {
    this.account = account;
  }

  /** Shorthand for `this.account.accountId`. */
  get accountId(): string {
    return this.account.accountId;
  }

  // ---- Static factory / cache ------------------------------------------------

  /** Resolve account from config and return a cached `LarkClient`. */
  static fromCfg(cfg: ClawdbotConfig, accountId?: string): LarkClient {
    return LarkClient.fromAccount(getLarkAccount(cfg, accountId));
  }

  /**
   * Get (or create) a cached `LarkClient` for the given account.
   * If the cached instance has stale credentials it is replaced.
   */
  static fromAccount(account: LarkAccount): LarkClient {
    const existing = cache.get(account.accountId);
    if (
      existing &&
      existing.account.appId === account.appId &&
      credentialsEqual(existing.account.appSecret, account.appSecret)
    ) {
      return existing;
    }
    // Credentials changed — tear down the stale instance before replacing it.
    if (existing) {
      log.info(`credentials changed, disposing stale instance`, { accountId: account.accountId });
      existing.dispose();
    }
    const instance = new LarkClient(account);
    cache.set(account.accountId, instance);
    return instance;
  }

  /**
   * Create an ephemeral `LarkClient` from bare credentials.
   * The instance is **not** added to the global cache — suitable for
   * one-off probe / diagnose calls that should not pollute account state.
   */
  static fromCredentials(credentials: LarkClientCredentials, options?: { wsFactory?: (params: any) => Lark.WSClient }): LarkClient {
    const base = {
      accountId: credentials.accountId ?? 'default',
      enabled: true as const,
      brand: credentials.brand ?? ('feishu' as const),
      config: {} as any,
    };

    const account: LarkAccount =
      credentials.appId && credentials.appSecret
        ? { ...base, configured: true as const, appId: credentials.appId, appSecret: credentials.appSecret }
        : { ...base, configured: false as const, appId: credentials.appId, appSecret: credentials.appSecret };

    return new LarkClient(account, options?.wsFactory);
  }

  /** Look up a cached instance by accountId. */
  static get(accountId: string): LarkClient | null {
    return cache.get(accountId) ?? null;
  }

  /**
   * Dispose one or all cached instances.
   * With `accountId` — dispose that single instance.
   * Without — dispose every cached instance and clear the cache.
   */
  static async clearCache(accountId?: string): Promise<void> {
    if (accountId !== undefined) {
      cache.get(accountId)?.dispose();
      clearUserNameCache(accountId);
      clearChatInfoCache(accountId);
    } else {
      for (const inst of cache.values()) inst.dispose();
      clearUserNameCache();
      clearChatInfoCache();
    }
  }

  // ---- SDK client (lazy) -----------------------------------------------------

  /** Lazily-created Lark SDK client. */
  get sdk(): Lark.Client {
    if (!this._sdk) {
      const { appId, appSecret } = this.requireCredentials();
      this._sdk = new Lark.Client({
        appId,
        appSecret,
        appType: Lark.AppType.SelfBuild,
        domain: resolveBrand(this.account.brand),
      });
    }
    return this._sdk;
  }

  // ---- Bot identity ----------------------------------------------------------

  /**
   * Probe bot identity via the `bot/v1/openclaw_bot/ping` API.
   * Results are cached on the instance for subsequent access via
   * `botOpenId` / `botName`.
   */
  async probe(opts?: { maxAgeMs?: number; needBotInfo?: boolean }): Promise<FeishuProbeResult> {
    const maxAge = opts?.maxAgeMs ?? 0;

    if (maxAge > 0 && this._lastProbeResult && Date.now() - this._lastProbeAt < maxAge) {
      return this._lastProbeResult;
    }

    if (!this.account.appId || !this.account.appSecret) {
      return { ok: false, error: 'missing credentials (appId, appSecret)' };
    }

    try {
      const needBotInfo = opts?.needBotInfo ?? true;
      const res = await (this.sdk as any).request({
        method: 'POST',
        url: '/open-apis/bot/v1/openclaw_bot/ping',
        data: { needBotInfo },
      });

      if (res.code !== 0) {
        const result: FeishuProbeResult = {
          ok: false,
          appId: this.account.appId,
          error: `API error: ${res.msg || `code ${res.code}`}`,
        };
        this._lastProbeResult = result;
        this._lastProbeAt = Date.now();
        return result;
      }

      const botInfo = res.data?.pingBotInfo;
      this._botOpenId = botInfo?.botID;
      this._botName = botInfo?.botName;

      const result: FeishuProbeResult = {
        ok: true,
        appId: this.account.appId,
        botName: this._botName,
        botOpenId: this._botOpenId,
      };
      this._lastProbeResult = result;
      this._lastProbeAt = Date.now();
      return result;
    } catch (err) {
      const result: FeishuProbeResult = {
        ok: false,
        appId: this.account.appId,
        error: err instanceof Error ? err.message : String(err),
      };
      this._lastProbeResult = result;
      this._lastProbeAt = Date.now();
      return result;
    }
  }

  /** Cached bot open_id (available after `probe()` or `startWS()`). */
  get botOpenId(): string | undefined {
    return this._botOpenId;
  }

  /** Cached bot name (available after `probe()` or `startWS()`). */
  get botName(): string | undefined {
    return this._botName;
  }

  // ---- WebSocket lifecycle ---------------------------------------------------

  /**
   * Start WebSocket event monitoring.
   *
   * Flow: probe bot identity → EventDispatcher → WSClient → start.
   * Resolves once the current receive connection is ready, or immediately when
   * an already-aborted signal stops it. Reconnects replace only the socket;
   * channel sessions, active agents and durable dedup state stay untouched.
   */
  async startWS(opts: {
    handlers: Record<string, (data: unknown) => Promise<void>>;
    abortSignal?: AbortSignal;
    autoProbe?: boolean;
  }): Promise<void> {
    const { handlers, abortSignal, autoProbe = true } = opts;
    this._wsHandlers = handlers;
    this._wsAbortSignal = abortSignal;
    this._wsStopped = false;
    this._wsBackoffMs = 5000;

    if (autoProbe) await this.probe();

    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.account.encryptKey ?? '',
      verificationToken: this.account.verificationToken ?? '',
    });
    dispatcher.register(handlers as any);

    const { appId, appSecret } = this.requireCredentials();
    // Close any existing WSClient before creating a new one to prevent
    // orphaned connections when startWS is called multiple times.
    if (this._wsClient) {
      log.warn(`closing previous WSClient before reconnect`, { accountId: this.accountId });
      try {
        this._wsClient.close({ force: true });
      } catch {
        // Ignore — the old client may already be torn down.
      }
      this._wsClient = null;
    }

    let attemptSettled = false;
    let attemptReady!: () => void;
    let attemptFailed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      attemptReady = () => {
        if (attemptSettled) return;
        attemptSettled = true;
        resolve();
      };
      attemptFailed = (error: unknown) => {
        if (attemptSettled) return;
        attemptSettled = true;
        reject(error);
      };
    });
    const generation = ++this._wsConnectionGeneration;
    let socket: Lark.WSClient;
    const stale = () => generation !== this._wsConnectionGeneration || this._wsClient !== socket;
    socket = (this.wsFactory ?? ((params: any) => new Lark.WSClient(params)))({
      appId,
      appSecret,
      domain: resolveBrand(this.account.brand),
      loggerLevel: Lark.LoggerLevel.info,
      // Keep the SDK liveness/reconnect enabled; surface every state transition.
      autoReconnect: true,
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15000,
      onReady: () => {
        if (stale()) return;
        this._wsBackoffMs = 5000;
        attemptReady();
        log.info('ws connected', { accountId: this.accountId });
      },
      onReconnecting: () => {
        if (!stale()) log.warn('ws reconnecting', {
          accountId: this.accountId,
          attempt: this.wsConnectionStatus?.reconnectAttempts,
        });
      },
      onReconnected: () => {
        if (stale()) return;
        this._wsBackoffMs = 5000;
        log.info('ws reconnected', { accountId: this.accountId });
      },
      onError: (error: unknown) => {
        if (stale()) return;
        log.error('ws terminal error; scheduling a fresh connection', { accountId: this.accountId, error: String(error) });
        attemptFailed(error);
        this.scheduleWsReconnect();
      },
    });
    this._wsClient = socket;

    // SDK 的 handleEventData 只处理 type="event"，card action 回调是 type="card" 会被丢弃。
    // 打 patch 将 "card" 类型消息改成 "event" 后交给原 handler，让 EventDispatcher 正常路由。
    const wsClientAny = this._wsClient as any;
    const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
    wsClientAny.handleEventData = (data: any) => {
      const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
      if (msgType === 'card') {
        const patchedData = {
          ...data,
          headers: data.headers.map((h: any) => (h.key === 'type' ? { ...h, value: 'event' } : h)),
        };
        return origHandleEventData(patchedData);
      }
      return origHandleEventData(data);
    };
    this.startWsWatchdog();

    await this.waitForAbort(dispatcher, abortSignal, ready, attemptFailed);
  }

  /** Whether a WebSocket client is currently active. */
  get wsConnected(): boolean {
    if (!this._wsClient) return false;
    const status = (this._wsClient as any).getConnectionStatus?.();
    return status ? status.state === 'connected' : true;
  }

  /** Exposed for health tests and operational introspection, without app credentials. */
  get wsConnectionStatus(): { state: string; lastConnectTime?: number; nextConnectTime?: number; reconnectAttempts?: number } | null {
    return (this._wsClient as any)?.getConnectionStatus?.() ?? null;
  }

  private startWsWatchdog(): void {
    if (this._wsWatchdog) clearInterval(this._wsWatchdog);
    this._wsWatchdog = setInterval(() => {
      if (this._wsStopped || !this._wsClient) return;
      const state = this.wsConnectionStatus?.state;
      if (state === 'failed' || state === 'idle') {
        log.warn('ws receive connection is not healthy; rebuilding', { accountId: this.accountId, state });
        this.scheduleWsReconnect();
      }
    }, 15000);
    this._wsWatchdog.unref();
  }

  /** One reconnect per bot, bounded backoff; never rebuild a healthy socket or agent. */
  private scheduleWsReconnect(): void {
    if (this._wsStopped || this._wsReconnecting || !this._wsHandlers) return;
    const delay = this._wsReconnectDelayMs;
    this._wsReconnectDelayMs = 5000;
    this._wsBackoffMs = Math.min(this._wsBackoffMs * 2, 60000);
    this._wsReconnecting = (async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this._wsStopped || !this._wsHandlers) return;
      try {
        const handlers = this._wsHandlers;
        const signal = this._wsAbortSignal;
        this.disconnect();
        await this.startWS({ handlers, abortSignal: signal, autoProbe: false });
      } catch (error) {
        log.error('ws rebuild failed; retrying with backoff', { accountId: this.accountId, error: String(error) });
        // Clear the in-flight marker before scheduling; schedule is single-flight.
        this._wsReconnecting = null;
        this.scheduleWsReconnect();
      }
    })().finally(() => { this._wsReconnecting = null; });
  }

  /** Disconnect WebSocket but keep instance in cache. */
  disconnect(): void {
    this._wsStopped = true;
    this._wsConnectionGeneration++;

    if (this._wsWatchdog) {
      clearInterval(this._wsWatchdog);
      this._wsWatchdog = null;
    }
    if (this._wsClient) {
      log.info(`disconnecting WebSocket`, { accountId: this.accountId });
      try {
        this._wsClient.close({ force: true });
      } catch {
        // Ignore errors during close — the client may already be torn down.
      }
    }
    this._wsClient = null;
    if (this.messageDedup) {
      log.info(`disposing message dedup`, { accountId: this.accountId, size: this.messageDedup.size });
      this.messageDedup.dispose();
      this.messageDedup = null;
    }
  }

  /** Disconnect + remove from cache. */
  dispose(): void {
    this.disconnect();
    cache.delete(this.accountId);
  }

  // ---- Private helpers -------------------------------------------------------

  /** Assert credentials exist or throw. */
  private requireCredentials(): { appId: string; appSecret: string } {
    const appId = this.account.appId;
    const appSecret = this.account.appSecret;
    if (!appId || !appSecret) {
      throw new Error(`LarkClient[${this.accountId}]: appId and appSecret are required`);
    }
    return { appId, appSecret };
  }

  /**
   * Resolve after this attempt is ready. Abort intentionally leaves a pending
   * attempt promise settled only by the fail callback, avoiding unhandled
   * rejections from stale sockets during teardown.
   */
  private waitForAbort(
    dispatcher: Lark.EventDispatcher,
    signal: AbortSignal | undefined,
    ready: Promise<void>,
    fail: (error: unknown) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        this.disconnect();
        return resolve();
      }

      signal?.addEventListener(
        'abort',
        () => {
          this.disconnect();
          fail(new Error(`Feishu WebSocket disconnected (${this.accountId})`));
          resolve();
        },
        { once: true },
      );

      try {
        void this._wsClient!.start({ eventDispatcher: dispatcher });
        const timer = setTimeout(() => {
          fail(new Error(`Feishu WebSocket initial ready timeout (${this.accountId})`));
          this.scheduleWsReconnect();
        }, 20000);
        void ready.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
      } catch (err) {
        this.disconnect();
        reject(err);
      }
    });
  }
}

// Inject LarkClient reference into chat-info-cache to break the circular
// dependency (chat-info-cache needs LarkClient.fromCfg but lark-client
// imports clearChatInfoCache from chat-info-cache).
injectLarkClient(LarkClient);

// ---------------------------------------------------------------------------
// Config resolution helper
// ---------------------------------------------------------------------------

/**
 * Returns the best available config for account resolution.
 *
 * Priority: live config (has `channels.feishu`) > fallback (has
 * `channels.feishu`) > live config (last resort).
 *
 * The `config` object captured in tool-registration closures may be stale
 * after a hot-reload, so we prefer the live config from
 * `LarkClient.runtime.config.loadConfig()`.  However, `loadConfig()` may
 * return `{}` when the runtime config snapshot has been cleared (e.g. in
 * isolated cron sessions), so we fall back to the closure-captured config
 * when the live result lacks Feishu credentials.
 *
 * @param fallback - Config to use when the runtime is not yet initialised
 *   or when `loadConfig()` returns an incomplete config.
 */
export function getResolvedConfig(fallback: ClawdbotConfig): ClawdbotConfig {
  try {
    const live = LarkClient.runtime.config.loadConfig() as ClawdbotConfig;
    // loadConfig() may return {} (empty config) when runtimeConfigSnapshot
    // has been cleared (e.g. after writeConfigFile, secrets teardown, or
    // concurrent cron race conditions in isolated sessions).  In that case
    // the closure-captured fallback still holds a valid resolved config.
    if (live?.channels?.feishu) return live;
    if (fallback?.channels?.feishu) {
      log.debug(`loadConfig() returned config without channels.feishu, using fallback`);
      return fallback;
    }
    return live;
  } catch {
    // runtime not yet initialised — fall back to passed config
    return fallback;
  }
}
