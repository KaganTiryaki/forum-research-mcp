import { DatabaseSync } from "node:sqlite";

export class ResearchCache {
  private readonly database: DatabaseSync;

  constructor(path = "forum-research.sqlite", private readonly now: () => number = Date.now) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS research_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  get<T>(key: string): T | undefined {
    const row = this.database
      .prepare("SELECT value_json, expires_at FROM research_cache WHERE cache_key = ?")
      .get(key) as { value_json: string; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= this.now()) {
      this.database.prepare("DELETE FROM research_cache WHERE cache_key = ?").run(key);
      return undefined;
    }
    return JSON.parse(row.value_json) as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.database
      .prepare(`
        INSERT INTO research_cache (cache_key, value_json, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at
      `)
      .run(key, JSON.stringify(value), this.now() + ttlMs);
  }

  close(): void {
    this.database.close();
  }
}
