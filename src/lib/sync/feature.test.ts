import { afterEach, describe, expect, it } from "vitest";
import { isSyncEnabled } from "./feature";

const ORIGINAL = process.env.NEXT_PUBLIC_ENABLE_SYNC;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_ENABLE_SYNC;
  else process.env.NEXT_PUBLIC_ENABLE_SYNC = ORIGINAL;
});

describe("isSyncEnabled", () => {
  it("is off by default so public builds hide the personal sync feature", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_SYNC;
    expect(isSyncEnabled()).toBe(false);
  });

  it("stays off for any value other than 1", () => {
    process.env.NEXT_PUBLIC_ENABLE_SYNC = "true";
    expect(isSyncEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_ENABLE_SYNC = "0";
    expect(isSyncEnabled()).toBe(false);
  });

  it("turns on only when NEXT_PUBLIC_ENABLE_SYNC is 1", () => {
    process.env.NEXT_PUBLIC_ENABLE_SYNC = "1";
    expect(isSyncEnabled()).toBe(true);
  });
});
