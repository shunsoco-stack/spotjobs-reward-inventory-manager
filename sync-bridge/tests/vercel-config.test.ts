import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vercel production routing", () => {
  it("routes the stable v1 health and dynamic snapshot URLs to their functions", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { rewrites?: Array<{ source: string; destination: string }> };

    expect(config.rewrites).toEqual(
      expect.arrayContaining([
        { source: "/api/v1/health", destination: "/api/health" },
        {
          source: "/api/v1/snapshot/:channelId",
          destination: "/api/snapshot?channelId=:channelId",
        },
        {
          source: "/api/v1/refresh/:channelId",
          destination: "/api/refresh?channelId=:channelId",
        },
      ]),
    );
  });
});
