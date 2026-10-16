import { describe, expect, it, vi } from "vitest";
import {
  createNativeRuntimeAdapter,
  type NativeRuntimeDependencies,
} from "./native-runtime";

type InAppBrowserModule = Awaited<ReturnType<NativeRuntimeDependencies["loadInAppBrowser"]>>;
type FilesystemModule = Awaited<ReturnType<NativeRuntimeDependencies["loadFilesystem"]>>;

const asInAppBrowserModule = (value: unknown) => value as InAppBrowserModule;
const asFilesystemModule = (value: unknown) => value as FilesystemModule;

function dependencies(
  overrides: Partial<NativeRuntimeDependencies> = {},
): NativeRuntimeDependencies {
  return {
    getWindow: () => ({ open: vi.fn() }) as unknown as Pick<Window, "open">,
    getDocument: () => undefined,
    getNavigator: () => undefined,
    getCapacitor: () => undefined,
    getUrlApi: () => undefined,
    schedule: vi.fn(),
    loadInAppBrowser: vi.fn(async () => {
      throw new Error("native browser should not load");
    }),
    loadShare: vi.fn(async () => {
      throw new Error("native share should not load");
    }),
    loadFilesystem: vi.fn(async () => {
      throw new Error("native filesystem should not load");
    }),
    ...overrides,
  };
}

describe("native runtime detection", () => {
  it("is safe during SSR and does not inspect or load native capabilities", () => {
    const getCapacitor = vi.fn(() => {
      throw new Error("must not be called on the server");
    });
    const loadShare = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getWindow: () => undefined,
      getCapacitor,
      loadShare,
    }));

    expect(adapter.getPlatform()).toBe("server");
    expect(adapter.isNativeRuntime()).toBe(false);
    expect(getCapacitor).not.toHaveBeenCalled();
    expect(loadShare).not.toHaveBeenCalled();
  });

  it("detects an injected iOS bridge and tolerates a broken bridge", () => {
    const native = createNativeRuntimeAdapter(dependencies({
      getCapacitor: () => ({ isNativePlatform: () => true, getPlatform: () => "ios" }),
    }));
    const broken = createNativeRuntimeAdapter(dependencies({
      getCapacitor: () => ({ isNativePlatform: () => { throw new Error("bridge unavailable"); } }),
    }));

    expect(native.getPlatform()).toBe("ios");
    expect(native.isNativeRuntime()).toBe(true);
    expect(broken.getPlatform()).toBe("web");
    expect(broken.isNativeRuntime()).toBe(false);
  });
});

describe("external URLs", () => {
  it("opens web URLs immediately in a separate, isolated browser context", async () => {
    const open = vi.fn();
    const loadInAppBrowser = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getWindow: () => ({ open }) as unknown as Pick<Window, "open">,
      loadInAppBrowser,
    }));

    const pending = adapter.openExternalUrl("https://app.spot.jobs/");
    expect(open).toHaveBeenCalledWith("https://app.spot.jobs/", "_blank", "noopener,noreferrer");
    await expect(pending).resolves.toEqual({
      method: "web-window",
      url: "https://app.spot.jobs/",
    });
    expect(loadInAppBrowser).not.toHaveBeenCalled();
  });

  it("uses the native external browser plugin on iOS", async () => {
    const openInExternalBrowser = vi.fn(async () => undefined);
    const open = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getWindow: () => ({ open }) as unknown as Pick<Window, "open">,
      getCapacitor: () => ({ isNativePlatform: () => true, getPlatform: () => "ios" }),
      loadInAppBrowser: async () => asInAppBrowserModule({ InAppBrowser: { openInExternalBrowser } }),
    }));

    await expect(adapter.openExternalUrl("https://app.spot.jobs/")).resolves.toEqual({
      method: "native-external-browser",
      url: "https://app.spot.jobs/",
    });
    expect(openInExternalBrowser).toHaveBeenCalledWith({ url: "https://app.spot.jobs/" });
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects unsafe protocols before opening anything", async () => {
    const open = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getWindow: () => ({ open }) as unknown as Pick<Window, "open">,
    }));

    await expect(adapter.openExternalUrl("javascript:alert(1)")).rejects.toThrow("httpまたはhttps");
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to the browser if the native plugin is unavailable", async () => {
    const open = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getWindow: () => ({ open }) as unknown as Pick<Window, "open">,
      getCapacitor: () => ({ isNativePlatform: () => true, getPlatform: () => "ios" }),
      loadInAppBrowser: async () => { throw new Error("plugin unavailable"); },
    }));

    await expect(adapter.openExternalUrl("https://example.com/path")).resolves.toMatchObject({
      method: "web-window",
    });
    expect(open).toHaveBeenCalledWith("https://example.com/path", "_blank", "noopener,noreferrer");
  });
});

describe("text sharing", () => {
  it("opens the native share sheet with text and URL", async () => {
    const share = vi.fn(async () => ({ activityType: "com.apple.UIKit.activity.CopyToPasteboard" }));
    const adapter = createNativeRuntimeAdapter(dependencies({
      getCapacitor: () => ({ isNativePlatform: () => true, getPlatform: () => "ios" }),
      loadShare: async () => ({ Share: { canShare: async () => ({ value: true }), share } }),
    }));

    await expect(adapter.shareText({
      title: "今週の成績",
      text: "補充 54本",
      url: "https://spotjobs-reward-inventory-manager.vercel.app/",
      dialogTitle: "成績を共有",
    })).resolves.toEqual({
      method: "native-share",
      activityType: "com.apple.UIKit.activity.CopyToPasteboard",
    });
    expect(share).toHaveBeenCalledWith({
      title: "今週の成績",
      text: "補充 54本",
      url: "https://spotjobs-reward-inventory-manager.vercel.app/",
      dialogTitle: "成績を共有",
    });
  });

  it("uses Web Share and does not load the native plugin in a browser", async () => {
    const share = vi.fn(async () => undefined);
    const loadShare = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getNavigator: () => ({ share }),
      loadShare,
    }));

    await expect(adapter.shareText({ text: "今日の成績" })).resolves.toEqual({ method: "web-share" });
    expect(share).toHaveBeenCalledWith({ text: "今日の成績" });
    expect(loadShare).not.toHaveBeenCalled();
  });

  it("copies a complete message when Web Share fails", async () => {
    const writeText = vi.fn(async () => undefined);
    const adapter = createNativeRuntimeAdapter(dependencies({
      getNavigator: () => ({
        share: vi.fn(async () => { throw new Error("not allowed"); }),
        clipboard: { writeText },
      }),
    }));

    await expect(adapter.shareText({
      text: "今日の成績",
      url: "https://example.com/",
    })).resolves.toEqual({ method: "clipboard" });
    expect(writeText).toHaveBeenCalledWith("今日の成績\nhttps://example.com/");
  });

  it("treats closing a share sheet as cancellation instead of an error", async () => {
    const writeText = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getNavigator: () => ({
        share: vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); }),
        clipboard: { writeText },
      }),
    }));

    await expect(adapter.shareText({ text: "今日の成績" })).resolves.toEqual({ method: "cancelled" });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("text file export", () => {
  it("writes UTF-8 content to native cache and shares the resulting file URI", async () => {
    const writeFile = vi.fn(async () => ({ uri: "file:///cache/exports/spotjobs-backup.json" }));
    const share = vi.fn(async () => ({}));
    const adapter = createNativeRuntimeAdapter(dependencies({
      getCapacitor: () => ({ isNativePlatform: () => true, getPlatform: () => "ios" }),
      loadFilesystem: async () => asFilesystemModule({
        Directory: { Cache: "CACHE" },
        Encoding: { UTF8: "utf8" },
        Filesystem: { writeFile },
      }),
      loadShare: async () => ({ Share: { canShare: async () => ({ value: true }), share } }),
    }));

    await expect(adapter.exportTextFile({
      content: "{\"records\":[]}",
      filename: "spotjobs-backup.json",
      mimeType: "application/json",
      title: "SPOTJOBSバックアップ",
    })).resolves.toEqual({
      method: "native-share",
      filename: "spotjobs-backup.json",
      uri: "file:///cache/exports/spotjobs-backup.json",
    });
    expect(writeFile).toHaveBeenCalledWith({
      path: "exports/spotjobs-backup.json",
      data: "{\"records\":[]}",
      directory: "CACHE",
      encoding: "utf8",
      recursive: true,
    });
    expect(share).toHaveBeenCalledWith({
      title: "SPOTJOBSバックアップ",
      files: ["file:///cache/exports/spotjobs-backup.json"],
    });
  });

  it("downloads a Blob on the web and revokes its object URL", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const anchor = { href: "", download: "", rel: "", hidden: false, click, remove };
    const documentObject = {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    } as unknown as Document;
    const createObjectURL = vi.fn(() => "blob:spotjobs-backup");
    const revokeObjectURL = vi.fn();
    const schedule = vi.fn((callback: () => void) => callback());
    const loadFilesystem = vi.fn();
    const adapter = createNativeRuntimeAdapter(dependencies({
      getDocument: () => documentObject,
      getUrlApi: () => ({ createObjectURL, revokeObjectURL }),
      schedule,
      loadFilesystem,
    }));

    await expect(adapter.exportTextFile({
      content: "date,type,quantity",
      filename: "spotjobs-records.csv",
      mimeType: "text/csv;charset=utf-8",
    })).resolves.toEqual({ method: "web-download", filename: "spotjobs-records.csv" });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor).toMatchObject({
      href: "blob:spotjobs-backup",
      download: "spotjobs-records.csv",
      rel: "noopener",
      hidden: true,
    });
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:spotjobs-backup");
    expect(loadFilesystem).not.toHaveBeenCalled();
  });

  it("removes path separators before writing a native export", async () => {
    const writeFile = vi.fn(async () => ({ uri: "file:///cache/exports/.._backup.json" }));
    const adapter = createNativeRuntimeAdapter(dependencies({
      getCapacitor: () => ({ isNativePlatform: () => true, getPlatform: () => "ios" }),
      loadFilesystem: async () => asFilesystemModule({
        Directory: { Cache: "CACHE" },
        Encoding: { UTF8: "utf8" },
        Filesystem: { writeFile },
      }),
      loadShare: async () => ({
        Share: { canShare: async () => ({ value: true }), share: async () => ({}) },
      }),
    }));

    await adapter.exportTextFile({
      content: "{}",
      filename: "../backup.json",
      mimeType: "application/json",
    });
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: "exports/.._backup.json" }));
  });
});
