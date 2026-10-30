"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * 简单的文件系统 TTL 缓存。
 * 用于缓存公告 PDF 正文、数据源描述等可重复使用的响应。
 */
class FileCache {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.cacheDir = options.cacheDir || "";
    this.defaultTtlSeconds = Number(options.defaultTtlSeconds) > 0 ? Number(options.defaultTtlSeconds) : 3600;
    this.maxSizeBytes = Number(options.maxSizeBytes) > 0 ? Number(options.maxSizeBytes) : 100 * 1024 * 1024; // 100 MiB
    this.maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 1000;
  }

  _keyPath(key) {
    const hash = crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
    return path.join(this.cacheDir, `${hash}.json`);
  }

  async _ensureDir() {
    if (!this.enabled || !this.cacheDir) return;
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  async get(key) {
    if (!this.enabled || !this.cacheDir) return undefined;
    const filePath = this._keyPath(key);
    try {
      const stat = await fs.stat(filePath);
      const now = Date.now();
      if (now > stat.mtimeMs + this.defaultTtlSeconds * 1000) {
        await fs.unlink(filePath).catch(() => {});
        return undefined;
      }
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "value" in parsed) {
        return parsed.value;
      }
      return undefined;
    } catch (err) {
      if (err.code !== "ENOENT") {
        // 静默忽略读取错误
      }
      return undefined;
    }
  }

  async set(key, value) {
    if (!this.enabled || !this.cacheDir) return;
    await this._ensureDir();
    await this._evictIfNeeded();
    const filePath = this._keyPath(key);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify({ value, ts: Date.now() }), "utf8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  async _evictIfNeeded() {
    try {
      const entries = await fs.readdir(this.cacheDir);
      if (entries.length < this.maxEntries) return;
      const stats = [];
      let totalSize = 0;
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const fullPath = path.join(this.cacheDir, name);
        try {
          const s = await fs.stat(fullPath);
          stats.push({ path: fullPath, mtimeMs: s.mtimeMs, size: s.size });
          totalSize += s.size;
        } catch {
          // ignore
        }
      }
      // 按修改时间排序，删除最旧的直到满足限制
      stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let removed = 0;
      while (
        stats.length > 0 &&
        (stats.length > this.maxEntries * 0.8 || totalSize > this.maxSizeBytes * 0.8)
      ) {
        const oldest = stats.shift();
        if (!oldest) break;
        await fs.unlink(oldest.path).catch(() => {});
        totalSize -= oldest.size;
        removed++;
      }
      if (removed > 0) {
        // 清理完成
      }
    } catch {
      // ignore
    }
  }

  async clear() {
    if (!this.enabled || !this.cacheDir) return;
    try {
      if (fsSync.existsSync(this.cacheDir)) {
        await fs.rm(this.cacheDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

module.exports = { FileCache };
