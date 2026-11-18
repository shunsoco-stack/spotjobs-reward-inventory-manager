/** Minimal native D1 binding surface; no control-plane API credentials needed. */
export interface D1Result {
  success: boolean;
  meta: { changes: number };
}

export interface D1PreparedStatement {
  bind(...values: (string | number | null)[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export interface StorageEnvironment {
  DB: D1Database;
  SPOTLOG_GATEWAY_SECRET: string;
}
