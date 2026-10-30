/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Small OpenClaw SDK primitives replaced for the DSH port.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ACCOUNT_ID = 'default';

/**
 * OpenClaw's silent-reply sentinel: a reply payload starting with this token
 * is suppressed instead of delivered. Kept as a local constant so the card
 * stack never loads the OpenClaw runtime.
 */
export const SILENT_REPLY_TOKEN = 'NO_REPLY';

/**
 * Resolve the default agent id from an OpenClaw-shaped config subset
 * (`agents.list[].default`). Used only by the CardKit footer-metrics lookup;
 * an absent/default-less config falls back to `main`, mirroring upstream.
 * @param cfg - the config object (structural subset).
 * @returns the default agent id.
 */
export function resolveDefaultAgentId(cfg: Record<string, unknown>): string {
  const agents = cfg.agents;
  if (agents !== null && typeof agents === 'object') {
    const list = (agents as { list?: unknown }).list;
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object') continue;
        const candidate = entry as { default?: unknown; id?: unknown };
        if (candidate.default !== true) continue;
        if (typeof candidate.id === 'string' && candidate.id.trim() !== '') {
          return candidate.id.trim();
        }
      }
    }
    const defaults = (agents as { defaults?: unknown }).defaults;
    if (defaults !== null && typeof defaults === 'object') {
      const id = (defaults as { agentId?: unknown }).agentId;
      if (typeof id === 'string' && id.trim() !== '') return id.trim();
    }
  }
  return 'main';
}

export function normalizeAccountId(id: string): string | undefined {
  return id?.trim().toLowerCase() || undefined;
}

export function jsonResult(details: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

export function buildRandomTempFilePath(options: {
  prefix?: string;
  extension?: string;
  directory?: string;
} = {}): string {
  const prefix = options.prefix ?? 'feishu-';
  const extension = options.extension ?? '';
  return join(options.directory ?? tmpdir(), `${prefix}${randomUUID()}${extension}`);
}
