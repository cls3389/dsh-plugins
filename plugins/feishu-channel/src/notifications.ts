import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NotificationCardState } from './streaming.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { schedule: { kind: 'schedule' }; }
}

export interface FeishuNotificationInput {
  sessionId: string;
  ownerOpenId: string;
  ownerAppId: string;
  text: string;
  eventId: string;
}

export interface PreviousSessionInput {
  sessionId: string;
  previousSessionId: string;
  ownerOpenId: string;
  ownerAppId: string;
}

export interface NotificationRecord {
  input: FeishuNotificationInput;
  inputHash?: string;
  chatId: string;
  currentSessionId: string;
  status: 'accepted' | 'running' | 'completed';
  acceptedAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  card?: NotificationCardState;
  claimedTurn?: number;
  result?: { kind: string; text: string; error?: string };
  completedAt?: number;
  lastError?: string;
}

export function validateNotification(input: FeishuNotificationInput): void {
  for (const key of ['sessionId', 'ownerOpenId', 'ownerAppId', 'eventId', 'text'] as const) {
    if (typeof input?.[key] !== 'string' || !input[key].trim()) throw new Error(`Notification ${key} is required`);
  }
  if (input.eventId.length > 512 || input.text.length > 1_000_000) throw new Error('Notification exceeds size limit');
}

/** One bot owns one durable journal. No TTL: a completed event remains deduplicated. */
export class NotificationQueue {
  private readonly records = new Map<string, NotificationRecord>();
  private readonly scheduled = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private running = false;

  constructor(
    private readonly path: string,
    private readonly execute: (record: NotificationRecord) => Promise<void>,
    private readonly warn: (message: string) => void,
  ) {
    if (!existsSync(path)) return;
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { version: number; records: NotificationRecord[] };
    if (journal.version !== 1 || !Array.isArray(journal.records)) throw new Error('Invalid notification journal');
    for (const record of journal.records) {
      if (record.status !== 'completed' || !record.inputHash) validateNotification(record.input);
      if (!record.chatId || !record.currentSessionId || !['accepted', 'running', 'completed'].includes(record.status)) throw new Error('Invalid notification record');
      this.records.set(record.input.eventId, record);
    }
  }

  accept(input: FeishuNotificationInput, target: { chatId: string; currentSessionId: string }): void {
    if (this.stopped) throw new Error('Feishu notification channel is stopping');
    const existing = this.records.get(input.eventId);
    if (existing) {
      if ((existing.inputHash ?? inputHash(existing.input)) !== inputHash(input)) throw new Error('Notification eventId payload conflict');
      this.schedule(existing);
      return;
    }
    const now = Date.now();
    const record: NotificationRecord = { input: { ...input }, inputHash: inputHash(input), ...target, status: 'accepted', acceptedAt: now, updatedAt: now, attempts: 0, nextAttemptAt: 0 };
    this.records.set(input.eventId, record);
    try { this.persist(); } catch (error) { this.records.delete(input.eventId); throw error; }
    this.schedule(record);
  }

  start(): void {
    this.running = true;
    for (const record of this.records.values()) this.schedule(record);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  checkpoint(record: NotificationRecord, patch: Partial<NotificationRecord>): void {
    Object.assign(record, patch, { updatedAt: Date.now() });
    if (patch.status === 'completed') {
      // Keep full receipts for the newest 100 turns; older events retain permanent
      // id/hash/owner/card tombstones, never prompt or model answer text.
      const completed = [...this.records.values()].filter((item) => item.status === 'completed').sort((a, b) => b.updatedAt - a.updatedAt);
      for (const item of completed.slice(100)) {
        item.inputHash ??= inputHash(item.input);
        item.input.text = '';
        if (item.result) item.result = { kind: item.result.kind, text: '' };
      }
    }
    this.persist();
  }

  status(eventId?: string): NotificationRecord[] {
    return structuredClone([...this.records.values()].filter((record) => !eventId || record.input.eventId === eventId));
  }

  private schedule(record: NotificationRecord): void {
    const id = record.input.eventId;
    if (!this.running || this.stopped || record.status === 'completed' || this.scheduled.has(id)) return;
    this.scheduled.add(id);
    const delay = Math.max(0, record.nextAttemptAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (this.stopped) { this.scheduled.delete(id); return; }
      void this.run(record);
    }, delay);
    timer.unref();
    this.timers.set(id, timer);
  }

  private async run(record: NotificationRecord): Promise<void> {
    try {
      this.checkpoint(record, { status: 'running', attempts: record.attempts + 1 });
      await this.execute(record);
      if (!this.stopped) this.checkpoint(record, { status: 'completed', completedAt: Date.now(), nextAttemptAt: 0 });
    } catch (error) {
      if (!this.stopped) {
        try {
          this.checkpoint(record, { status: 'accepted', lastError: String(error), nextAttemptAt: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(record.attempts - 1, 6)) });
        } catch (persistError) { this.warn(`notification retry checkpoint failed: ${String(persistError)}`); }
        this.warn(`notification ${record.input.eventId} deferred: ${String(error)}`);
      }
    } finally {
      this.scheduled.delete(record.input.eventId);
      this.schedule(record);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

function inputHash(input: FeishuNotificationInput): string {
  return createHash('sha256').update(JSON.stringify([input.sessionId, input.ownerOpenId, input.ownerAppId, input.eventId, input.text])).digest('hex');
}

/** Feishu's idempotency key has a 50-character bound. */
export function notificationUuid(eventId: string): string {
  return createHash('sha256').update(eventId).digest('hex').slice(0, 48);
}
