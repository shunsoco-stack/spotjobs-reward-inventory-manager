/**
 * Browser/native capability boundary.
 *
 * This module must stay safe to import during Next.js static rendering. Native
 * plugins are therefore loaded only after an operation is invoked in an
 * injected Capacitor runtime. Browser implementations remain the fallback for
 * the deployed PWA.
 */

type RuntimePlatform = "server" | "web" | "ios" | "android" | "native";

interface CapacitorBridge {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

type InAppBrowserModule = Pick<typeof import("@capacitor/inappbrowser"), "InAppBrowser">;
type ShareModule = Pick<typeof import("@capacitor/share"), "Share">;
type FilesystemModule = Pick<
  typeof import("@capacitor/filesystem"),
  "Directory" | "Encoding" | "Filesystem"
>;

type WindowLike = Pick<Window, "open">;
interface NavigatorLike {
  clipboard?: Pick<Clipboard, "writeText">;
  share?: (data: ShareData) => Promise<void>;
}
type UrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export interface NativeRuntimeDependencies {
  getWindow(): WindowLike | undefined;
  getDocument(): Document | undefined;
  getNavigator(): NavigatorLike | undefined;
  getCapacitor(): CapacitorBridge | undefined;
  getUrlApi(): UrlApi | undefined;
  schedule(callback: () => void, delayMs: number): void;
  loadInAppBrowser(): Promise<InAppBrowserModule>;
  loadShare(): Promise<ShareModule>;
  loadFilesystem(): Promise<FilesystemModule>;
}

export interface OpenExternalUrlResult {
  method: "native-external-browser" | "web-window";
  url: string;
}

export interface ShareTextOptions {
  text: string;
  title?: string;
  url?: string;
  dialogTitle?: string;
}

export interface ShareTextResult {
  method: "native-share" | "web-share" | "clipboard" | "cancelled";
  activityType?: string;
}

export interface ExportTextFileOptions {
  content: string;
  filename: string;
  mimeType: string;
  title?: string;
  dialogTitle?: string;
}

export interface ExportTextFileResult {
  method: "native-share" | "web-download" | "cancelled";
  filename: string;
  uri?: string;
}

export interface NativeRuntimeAdapter {
  getPlatform(): RuntimePlatform;
  isNativeRuntime(): boolean;
  openExternalUrl(url: string): Promise<OpenExternalUrlResult>;
  shareText(options: ShareTextOptions): Promise<ShareTextResult>;
  exportTextFile(options: ExportTextFileOptions): Promise<ExportTextFileResult>;
}

const defaultDependencies: NativeRuntimeDependencies = {
  getWindow: () => (typeof window === "undefined" ? undefined : window),
  getDocument: () => (typeof document === "undefined" ? undefined : document),
  getNavigator: () => (typeof navigator === "undefined" ? undefined : navigator),
  getCapacitor: () => {
    if (typeof window === "undefined") return undefined;
    return (window as Window & { Capacitor?: CapacitorBridge }).Capacitor;
  },
  getUrlApi: () => (typeof URL === "undefined" ? undefined : URL),
  schedule: (callback, delayMs) => {
    globalThis.setTimeout(callback, delayMs);
  },
  loadInAppBrowser: () => import("@capacitor/inappbrowser"),
  loadShare: () => import("@capacitor/share"),
  loadFilesystem: () => import("@capacitor/filesystem"),
};

function normalizeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("外部URLには有効な絶対URLを指定してください。");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("外部URLにはhttpまたはhttpsのみ使用できます。");
  }

  return parsed.toString();
}

function normalizeFilename(value: string): string {
  const normalized = value.trim().replace(/[\\/\0]/g, "_");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new TypeError("書き出すファイル名を指定してください。");
  }
  return normalized;
}

function shareableText({ text, url }: Pick<ShareTextOptions, "text" | "url">): string {
  return [text.trim(), url?.trim()].filter(Boolean).join("\n");
}

function isCancelled(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /cancel(?:led|ed)|キャンセル/i.test(error.message);
}

function browserDownload(
  dependencies: NativeRuntimeDependencies,
  options: ExportTextFileOptions,
  filename: string,
): ExportTextFileResult {
  const documentObject = dependencies.getDocument();
  const urlApi = dependencies.getUrlApi();
  if (!documentObject || !urlApi) {
    throw new Error("この環境ではファイルを書き出せません。");
  }

  const objectUrl = urlApi.createObjectURL(new Blob([options.content], { type: options.mimeType }));
  const anchor = documentObject.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  documentObject.body.appendChild(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    dependencies.schedule(() => urlApi.revokeObjectURL(objectUrl), 30_000);
  }

  return { method: "web-download", filename };
}

export function createNativeRuntimeAdapter(
  overrides: Partial<NativeRuntimeDependencies> = {},
): NativeRuntimeAdapter {
  const dependencies: NativeRuntimeDependencies = { ...defaultDependencies, ...overrides };

  const getPlatform = (): RuntimePlatform => {
    if (!dependencies.getWindow()) return "server";

    const capacitor = dependencies.getCapacitor();
    try {
      if (!capacitor?.isNativePlatform?.()) return "web";
      const platform = capacitor.getPlatform?.();
      if (platform === "ios" || platform === "android") return platform;
      return "native";
    } catch {
      return "web";
    }
  };

  const isNativeRuntime = () => {
    const platform = getPlatform();
    return platform === "ios" || platform === "android" || platform === "native";
  };

  const openWithBrowserFallback = (url: string): OpenExternalUrlResult => {
    const browserWindow = dependencies.getWindow();
    if (!browserWindow) throw new Error("この環境では外部ブラウザを開けません。");
    browserWindow.open(url, "_blank", "noopener,noreferrer");
    return { method: "web-window", url };
  };

  const openExternalUrl = async (value: string): Promise<OpenExternalUrlResult> => {
    const url = normalizeHttpUrl(value);
    if (!isNativeRuntime()) return openWithBrowserFallback(url);

    try {
      const { InAppBrowser } = await dependencies.loadInAppBrowser();
      await InAppBrowser.openInExternalBrowser({ url });
      return { method: "native-external-browser", url };
    } catch {
      return openWithBrowserFallback(url);
    }
  };

  const shareWithBrowserFallback = async (options: ShareTextOptions): Promise<ShareTextResult> => {
    const browserNavigator = dependencies.getNavigator();
    const payload = {
      ...(options.title ? { title: options.title } : {}),
      text: options.text,
      ...(options.url ? { url: normalizeHttpUrl(options.url) } : {}),
    };

    if (browserNavigator?.share) {
      try {
        await browserNavigator.share(payload);
        return { method: "web-share" };
      } catch (error) {
        if (isCancelled(error)) return { method: "cancelled" };
      }
    }

    if (browserNavigator?.clipboard?.writeText) {
      await browserNavigator.clipboard.writeText(shareableText(options));
      return { method: "clipboard" };
    }

    throw new Error("この環境では共有またはクリップボードへのコピーを利用できません。");
  };

  const shareText = async (options: ShareTextOptions): Promise<ShareTextResult> => {
    if (!options.text.trim()) throw new TypeError("共有する本文を指定してください。");
    if (!isNativeRuntime()) return shareWithBrowserFallback(options);

    try {
      const { Share } = await dependencies.loadShare();
      if (!(await Share.canShare()).value) return shareWithBrowserFallback(options);

      try {
        const result = await Share.share({
          ...(options.title ? { title: options.title } : {}),
          text: options.text,
          ...(options.url ? { url: normalizeHttpUrl(options.url) } : {}),
          ...(options.dialogTitle ? { dialogTitle: options.dialogTitle } : {}),
        });
        return { method: "native-share", activityType: result.activityType };
      } catch (error) {
        if (isCancelled(error)) return { method: "cancelled" };
        return shareWithBrowserFallback(options);
      }
    } catch {
      return shareWithBrowserFallback(options);
    }
  };

  const exportTextFile = async (options: ExportTextFileOptions): Promise<ExportTextFileResult> => {
    const filename = normalizeFilename(options.filename);
    if (!options.mimeType.trim()) throw new TypeError("書き出すファイルのMIME typeを指定してください。");
    if (!isNativeRuntime()) return browserDownload(dependencies, options, filename);

    try {
      const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
        dependencies.loadFilesystem(),
        dependencies.loadShare(),
      ]);
      if (!(await Share.canShare()).value) {
        return browserDownload(dependencies, options, filename);
      }

      const path = `exports/${filename}`;
      const { uri } = await Filesystem.writeFile({
        path,
        data: options.content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true,
      });

      try {
        try {
          await Share.share({
            ...(options.title ? { title: options.title } : {}),
            files: [uri],
            ...(options.dialogTitle ? { dialogTitle: options.dialogTitle } : {}),
          });
        } catch (error) {
          if (isCancelled(error)) return { method: "cancelled", filename, uri };
          throw error;
        }

        return { method: "native-share", filename, uri };
      } finally {
        // The chosen destination receives its own copy. Avoid accumulating
        // backups and CSV files in the app's temporary cache afterwards.
        await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
      }
    } catch (error) {
      if (isCancelled(error)) return { method: "cancelled", filename };
      return browserDownload(dependencies, options, filename);
    }
  };

  return { getPlatform, isNativeRuntime, openExternalUrl, shareText, exportTextFile };
}

const defaultAdapter = createNativeRuntimeAdapter();

export const getRuntimePlatform = () => defaultAdapter.getPlatform();
export const isNativeRuntime = () => defaultAdapter.isNativeRuntime();
export const openExternalUrl = (url: string) => defaultAdapter.openExternalUrl(url);
export const shareText = (options: ShareTextOptions) => defaultAdapter.shareText(options);
export const exportTextFile = (options: ExportTextFileOptions) => defaultAdapter.exportTextFile(options);
