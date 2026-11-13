import type { IncomingHttpHeaders } from "node:http";

// The Vercel runtime is compatible with this intentionally small surface. Keeping
// local structural types avoids shipping or installing the full runtime package.
export type VercelRequest = {
  method?: string;
  headers: IncomingHttpHeaders;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type VercelResponse = {
  setHeader(name: string, value: string | number | readonly string[]): VercelResponse;
  status(statusCode: number): VercelResponse;
  json(body: unknown): unknown;
  end(): unknown;
};
