"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { oauthDeviceHeaders, newDeviceId } = require("./identity");

const DEFAULT_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const REFRESH_THRESHOLD_RATIO = 0.5;

class AuthError extends Error {}
class TokenExpiredError extends AuthError {}

function localKimiCodeRoots() {
  const roots = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const candidate = path.resolve(p);
    if (seen.has(candidate)) return;
    seen.add(candidate);
    roots.push(candidate);
  };

  add(process.env.KIMI_CODE_HOME);
  add(process.env.KIMI_HOME);

  let homeDir = "";
  if (process.env.HOME) homeDir = process.env.HOME;
  else if (process.env.USERPROFILE) homeDir = process.env.USERPROFILE;
  else {
    try {
      homeDir = require("node:os").homedir();
    } catch {
      // ignore
    }
  }

  if (homeDir) {
    add(path.join(homeDir, ".kimi-code"));
    if (process.platform === "darwin") {
      add(path.join(homeDir, "Library", "Application Support", "kimi-code"));
      add(path.join(homeDir, "Library", "Application Support", "Kimi Code"));
    }
    if (process.platform === "win32") {
      add(path.join(homeDir, "AppData", "Roaming", "kimi-code"));
      add(path.join(homeDir, "AppData", "Roaming", "Kimi Code"));
      add(path.join(homeDir, "AppData", "Local", "kimi-code"));
      add(path.join(homeDir, "AppData", "Local", "Kimi Code"));
    }
  }

  if (process.env.APPDATA) add(path.join(process.env.APPDATA, "kimi-code"));
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, "kimi-code"));
  if (process.env.XDG_CONFIG_HOME) add(path.join(process.env.XDG_CONFIG_HOME, "kimi-code"));

  return roots;
}

function findKimiCodeHome() {
  for (const root of localKimiCodeRoots()) {
    const credentialsPath = path.join(root, "credentials", "kimi-code.json");
    if (fsSync.existsSync(credentialsPath)) return root;
  }
  return null;
}

function resolveCredentialsPath(configPath) {
  if (configPath) return path.resolve(configPath);
  const home = findKimiCodeHome();
  if (home) return path.join(home, "credentials", "kimi-code.json");
  return path.join(require("node:os").homedir(), ".kimi-code", "credentials", "kimi-code.json");
}

function resolveDeviceIdPath(configPath) {
  if (configPath) return path.resolve(configPath);
  const home = findKimiCodeHome();
  if (home) return path.join(home, "device_id");
  return path.join(require("node:os").homedir(), ".kimi-code", "device_id");
}

async function safeReadJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

function tokenFromCredentials(credentials) {
  if (!credentials || credentials.status === "revoked") return null;
  const accessToken = credentials.access_token;
  const refreshToken = credentials.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: typeof credentials.expires_at === "number" ? credentials.expires_at : 0,
    expiresIn: typeof credentials.expires_in === "number" ? credentials.expires_in : 0,
    tokenType: typeof credentials.token_type === "string" && credentials.token_type ? credentials.token_type : "Bearer",
    scope: typeof credentials.scope === "string" ? credentials.scope : "",
  };
}

function tokenFromOAuthPayload(payload) {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new AuthError("OAuth response missing access_token");
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new AuthError("OAuth response missing refresh_token");
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AuthError("OAuth response missing or invalid expires_in");
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn,
    expiresIn,
    tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}

class KimiAuth {
  constructor(options = {}) {
    this._apiKey = options.apiKey || "";
    this.dataDir = path.resolve(options.dataDir || "/tmp/openclaw/kimi-datasource");
    this.credentialsPath = resolveCredentialsPath(options.credentialsPath);
    this.deviceIdPath = resolveDeviceIdPath(options.deviceIdPath);
    this.oauthHost = (options.oauthHost || DEFAULT_OAUTH_HOST).replace(/\/$/, "");
    this.clientId = options.clientId || DEFAULT_CLIENT_ID;
    this.timeoutMs = (options.timeoutSeconds || 30) * 1000;
    this.proxy = options.proxy || "";
    this._deviceId = null;
    this._cachedToken = null;
    this._proxyAgent = this._buildProxyAgent();
    this._refreshPromise = null;
    this._initPromise = null;
  }

  get isApiKeyMode() {
    return Boolean(this._apiKey);
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
  }

  async _ensureInit() {
    if (!this._initPromise) {
      this._initPromise = this.init().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  async getDeviceId() {
    await this._ensureInit();
    if (this._deviceId) return this._deviceId;

    // 1. 从配置路径读取
    if (fsSync.existsSync(this.deviceIdPath)) {
      try {
        const id = (await fs.readFile(this.deviceIdPath, "utf8")).trim();
        if (id) {
          this._deviceId = id;
          await this._saveDeviceId(id);
          return id;
        }
      } catch (err) {
        // ignore
      }
    }

    // 2. 从插件数据目录读取
    const savedPath = path.join(this.dataDir, "device_id");
    if (fsSync.existsSync(savedPath)) {
      try {
        const id = (await fs.readFile(savedPath, "utf8")).trim();
        if (id) {
          this._deviceId = id;
          return id;
        }
      } catch (err) {
        // ignore
      }
    }

    // 3. 生成新的
    const id = newDeviceId();
    this._deviceId = id;
    await this._saveDeviceId(id);
    return id;
  }

  async _saveDeviceId(deviceId) {
    await this._ensureInit();
    const savedPath = path.join(this.dataDir, "device_id");
    await fs.writeFile(savedPath, deviceId, { mode: 0o600 });
  }

  async importLocalCredentials() {
    if (!fsSync.existsSync(this.credentialsPath)) {
      throw new AuthError(
        `未找到本机 Kimi Code 凭证文件：${this.credentialsPath}。` +
        "请先在当前机器执行 kimi login 登录，或配置 credentialsPath。"
      );
    }

    const data = await safeReadJson(this.credentialsPath);
    if (!data || typeof data !== "object") {
      throw new AuthError(`凭证文件 ${this.credentialsPath} 不是有效 JSON`);
    }

    const token = tokenFromCredentials(data);
    if (!token) {
      throw new AuthError(`凭证文件 ${this.credentialsPath} 缺少可用的 access_token 或 refresh_token`);
    }

    const deviceId = await this.getDeviceId();
    await this._saveToken(token, deviceId);
    this._cachedToken = token;
    return { token, deviceId };
  }

  async _loadSavedToken() {
    const savedPath = path.join(this.dataDir, "credentials.json");
    const data = await safeReadJson(savedPath);
    if (!data || typeof data !== "object") return null;
    return tokenFromCredentials(data);
  }

  async _saveToken(token, deviceId) {
    await this._ensureInit();
    const savedPath = path.join(this.dataDir, "credentials.json");
    const payload = {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: token.expiresAt,
      expires_in: token.expiresIn,
      token_type: token.tokenType,
      scope: token.scope,
      device_id: deviceId,
      status: "valid",
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(savedPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  }

  async ensureFreshToken() {
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = this._ensureFreshTokenInternal();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async _ensureFreshTokenInternal() {
    await this._ensureInit();
    if (this._apiKey) {
      const deviceId = await this.getDeviceId();
      return { token: { accessToken: this._apiKey }, deviceId };
    }

    if (this._cachedToken && !this._shouldRefresh(this._cachedToken, false)) {
      return { token: this._cachedToken, deviceId: await this.getDeviceId() };
    }

    let token = this._cachedToken || (await this._loadSavedToken());
    if (!token) {
      const imported = await this.importLocalCredentials();
      return { token: imported.token, deviceId: imported.deviceId };
    }

    if (!this._shouldRefresh(token, false)) {
      this._cachedToken = token;
      return { token, deviceId: await this.getDeviceId() };
    }

    const refreshed = await this.refreshAccessToken(token.refreshToken);
    const deviceId = await this.getDeviceId();
    await this._saveToken(refreshed, deviceId);
    this._cachedToken = refreshed;
    return { token: refreshed, deviceId };
  }

  _shouldRefresh(token, force = false) {
    if (force) return true;
    if (!token.expiresAt) return false;
    const threshold = Math.max(MIN_REFRESH_THRESHOLD_SECONDS, token.expiresIn * REFRESH_THRESHOLD_RATIO);
    return token.expiresAt - Math.floor(Date.now() / 1000) < threshold;
  }

  async refreshAccessToken(refreshToken) {
    const deviceId = await this.getDeviceId();
    const url = `${this.oauthHost}/api/oauth/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString();

    const fetchOptions = {
      method: "POST",
      headers: {
        ...oauthDeviceHeaders(deviceId),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (this._proxyAgent) {
      fetchOptions.agent = this._proxyAgent;
    }

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      throw new AuthError(`刷新 token 请求失败: ${err.message}`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const errorCode = data.error;
      if (response.status === 401 || response.status === 403 || errorCode === "invalid_grant") {
        throw new TokenExpiredError(`Kimi OAuth token 已失效，请重新登录 Kimi Code CLI: ${this._pickError(data)}`);
      }
      throw new AuthError(`刷新 token 失败 (HTTP ${response.status}): ${this._pickError(data)}`);
    }

    return tokenFromOAuthPayload(data);
  }

  _pickError(data) {
    if (!data || typeof data !== "object") return "unknown";
    return data.message || data.error_description || data.error || "unknown";
  }

  _buildProxyAgent() {
    // 简单支持 HTTP 代理；Node.js 原生 fetch 需要额外处理，这里用 node-fetch 风格兼容
    // 如果环境不支持，可忽略代理
    try {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      return new HttpsProxyAgent(this.proxy);
    } catch {
      return undefined;
    }
  }
}

module.exports = {
  KimiAuth,
  AuthError,
  TokenExpiredError,
  localKimiCodeRoots,
  findKimiCodeHome,
};
