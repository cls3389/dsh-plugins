import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** JSON backing file for Feishu message IDs; contains no message content. */
export class DedupStore {
  private readonly values = new Map<string, number>();

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [id, seenAt] of Object.entries(parsed)) {
        if (typeof seenAt === 'number' && Number.isFinite(seenAt)) this.values.set(id, seenAt);
      }
    } catch { /* Missing or corrupt state falls back to an empty ledger. */ }
  }

  get(id: string): number | undefined {
    return this.values.get(id);
  }

  set(id: string, seenAt: number): void {
    this.values.set(id, seenAt);
  }

  delete(id: string): void {
    this.values.delete(id);
  }

  sweep(expiresBefore: number, maxEntries: number): void {
    for (const [id, seenAt] of this.values) {
      if (seenAt < expiresBefore || this.values.size > maxEntries) this.values.delete(id);
      else break;
    }
    this.persist();
  }

  persist(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.values))}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      rmSync(temporary, { force: true });
    }
  }
}
