import type { Worker as OcrWorker } from 'tesseract.js';

export const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
export const MAX_SCREENSHOT_PIXELS = 24_000_000;
export const SCREENSHOT_ACCEPT = 'image/jpeg,image/png,image/webp';
export type ScreenshotOcrProgress = { progress: number; status: string };
export type ScreenshotOcrOptions = {
  onProgress?: (value: ScreenshotOcrProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const MODEL_CACHE = 'spotjobs-jpn-eng-tesseract7-models1-cjkcompat1';
let running = false;

function abortError() {
  return new DOMException('画像の読み取りを中止しました。', 'AbortError');
}

export function validateScreenshotFile(file: File): void {
  if (!file.size) throw new Error('空の画像は読み取れません。');
  if (file.size > MAX_SCREENSHOT_BYTES) throw new Error('画像は 1 枚 12 MB 以下にしてください。');
  const supported = ['image/jpeg', 'image/png', 'image/webp'];
  if (!(supported.includes(file.type.toLowerCase()) || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name)))) {
    throw new Error('JPEG・PNG・WebP の画像を選択してください。');
  }
}

/** Browser-only OCR. The file is decoded locally and never used as a fetch body. */
export async function recognizeScreenshot(file: File, options: ScreenshotOcrOptions = {}): Promise<string> {
  validateScreenshotFile(file);
  if (options.signal?.aborted) throw abortError();
  if (running) throw new Error('前の画像を読み取り中です。画像は 1 枚ずつ処理してください。');
  if (typeof window === 'undefined') throw new Error('画像の読み取りはブラウザで実行してください。');
  running = true;
  let finished = false;
  let worker: OcrWorker | undefined;
  let image: HTMLImageElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let imageUrl: string | undefined;
  let lastProgress = 0;
  let fail!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => { fail = reject; });
  const report = (progress: number, status: string) => {
    if (finished) return;
    lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, progress)));
    options.onProgress?.({ progress: lastProgress, status });
  };
  const stop = (error: Error) => {
    if (finished) return;
    finished = true;
    void worker?.terminate().catch(() => {});
    fail(error);
  };
  const onAbort = () => stop(abortError());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, 600_000) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => stop(new Error('画像の読み取りが時間内に終わりませんでした。通信状況を確認するか、画像を分割して再度お試しください。')), timeoutMs);

  try {
    // Attach the cancellation race before beginning asynchronous work. Tesseract's
    // terminate() does not reject its outstanding recognition promises itself.
    const work = async () => {
      report(0.01, '画像を確認しています');
      image = new Image();
      imageUrl = URL.createObjectURL(file);
      image.src = imageUrl;
      try { await image.decode(); } catch { throw new Error('画像を開けませんでした。JPEG・PNG・WebP で保存し直してください。'); }
      if (finished) throw abortError();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height || width * height > MAX_SCREENSHOT_PIXELS || Math.max(width, height) > 20_000) {
        throw new Error('画像が大きすぎます。2,400 万画素以下・一辺 20,000 px 以下に分割してください。');
      }
      canvas = document.createElement('canvas');
      // Small phone screenshots benefit from 2x text; cap the working bitmap so
      // an exceptionally tall screenshot cannot exhaust a phone's memory.
      const scale = Math.min(2, 1800 / width, Math.sqrt(9_000_000 / (width * height)));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('このブラウザでは画像を処理できません。');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.filter = 'grayscale(1) contrast(1.1)';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      report(0.05, '端末内の読み取り機能を準備しています');
      const { createWorker, OEM, PSM } = await import('tesseract.js');
      if (finished) throw abortError();
      const origin = window.location.origin;
      const created = await createWorker(['jpn', 'eng'], OEM.LSTM_ONLY, {
        workerPath: `${origin}/ocr/worker.min.js`,
        corePath: `${origin}/ocr/core`,
        langPath: `${origin}/ocr/lang`,
        workerBlobURL: false,
        gzip: true,
        cachePath: MODEL_CACHE,
        logger: event => {
          if (event.status === 'recognizing text') report(0.45 + event.progress * 0.54, '画像から文字を読み取っています');
          else if (event.status === 'loading language traineddata') report(0.15 + event.progress * 0.22, '日本語・英語モデルを準備しています（初回は通信が必要です）');
          else if (event.status === 'initializing api') report(0.38 + event.progress * 0.05, '文字の読み取りを開始しています');
          else report(0.08, '端末内の読み取り機能を準備しています');
        },
        errorHandler: () => stop(new Error('読み取り機能を準備・実行できませんでした。初回はオンラインで開き直してお試しください。')),
      });
      // The public API gives access to the worker only after initialization.
      // If cancelled during initialization, discard it as soon as it resolves.
      if (finished) { await created.terminate(); throw abortError(); }
      worker = created;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1', user_defined_dpi: '300' });
      if (finished) throw abortError();
      const result = await worker.recognize(canvas, {}, { text: true });
      if (finished) throw abortError();
      report(1, '読み取りが完了しました');
      return result.data.text.trim();
    };
    return await Promise.race([work(), stopped]);
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await worker?.terminate().catch(() => {});
    if (image) image.src = '';
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    running = false;
  }
}
