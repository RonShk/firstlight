// Thin wrapper over node:sqlite: WAL mode, a busy timeout so several worker processes can share one
// file, and re-entrant transactions (a nested call joins the outer transaction).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

export class Sqlite {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  }

  exec(sql: string) {
    this.db.exec(sql);
  }

  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]) {
    return this.db.prepare(sql).run(...params);
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so read-then-write sequences cannot race. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.db.close();
  }
}

export type SqlParam = null | number | bigint | string | Uint8Array;

export const json = (v: unknown) => JSON.stringify(v ?? null);
export const parse = <T>(v: unknown): T => (v == null ? (null as T) : (JSON.parse(String(v)) as T));
