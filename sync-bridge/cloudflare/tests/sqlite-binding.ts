import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database, D1PreparedStatement } from "../src/d1-types.ts";

/** Runs the production SQL in real SQLite, rather than mocking CAS semantics. */
export class SQLiteBinding implements D1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly statements: { sql: string; parameters: (string | number | null)[] }[] = [];

  constructor() {
    this.database.exec(readFileSync(new URL("../migrations/0001_storage.sql", import.meta.url), "utf8"));
  }

  prepare(sql: string): D1PreparedStatement {
    const build = (parameters: (string | number | null)[]): D1PreparedStatement => {
      const values: Record<string, SQLInputValue> = Object.fromEntries(parameters.map((value, index) => [String(index + 1), value]));
      return {
        bind: (...next) => build(next),
        first: async <T>() => {
          this.statements.push({ sql, parameters });
          return (this.database.prepare(sql).get(values) ?? null) as T | null;
        },
        run: async () => {
          this.statements.push({ sql, parameters });
          return { success: true, meta: { changes: Number(this.database.prepare(sql).run(values).changes) } };
        },
      };
    };
    return build([]);
  }

  close(): void { this.database.close(); }
}
