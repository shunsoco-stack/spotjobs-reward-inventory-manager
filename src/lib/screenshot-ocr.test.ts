import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREENSHOT_BYTES, recognizeScreenshot, validateScreenshotFile } from './screenshot-ocr';

const sdk = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock('tesseract.js', () => ({ ...sdk, OEM: { LSTM_ONLY: 1 }, PSM: { AUTO: '3' } }));
const file = () => new File(['image'], 'history.jpg', { type: 'image/jpeg' });
const makeWorker = () => ({ terminate: vi.fn().mockResolvedValue(undefined), setParameters: vi.fn().mockResolvedValue({}), recognize: vi.fn().mockResolvedValue({ data: { text: '  完了時間: 2026-08-20 10:20:30\n取出: 2 本  ' } }) });
let bitmap: { width: number; height: number; getContext: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 589; naturalHeight = 1280; decode() { return Promise.resolve(); } });
  bitmap = { width: 0, height: 0, getContext: vi.fn(() => ({ fillRect: vi.fn(), drawImage: vi.fn() })) };
  vi.stubGlobal('document', { createElement: () => bitmap });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('screenshot file boundaries', () => {
  it('accepts supported files and a recognized extension if MIME is absent', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) expect(() => validateScreenshotFile(new File(['x'], 'image', { type }))).not.toThrow();
    expect(() => validateScreenshotFile(new File(['x'], 'image.JPG'))).not.toThrow();
  });
  it('rejects empty, unsupported and oversized files before initializing OCR', () => {
    expect(() => validateScreenshotFile(new File([], 'x.jpg', { type: 'image/jpeg' }))).toThrow('空');
    expect(() => validateScreenshotFile(new File(['x'], 'x.jpg', { type: 'text/html' }))).toThrow('JPEG');
    expect(() => validateScreenshotFile({ size: MAX_SCREENSHOT_BYTES + 1, type: 'image/png', name: 'x.png' } as File)).toThrow('12 MB');
    expect(sdk.createWorker).not.toHaveBeenCalled();
  });
  it('rejects excessive decoded dimensions without loading the OCR library', async () => {
    vi.stubGlobal('Image', class { src = ''; naturalWidth = 8000; naturalHeight = 8000; decode() { return Promise.resolve(); } });
    await expect(recognizeScreenshot(file())).rejects.toThrow('大きすぎ');
    expect(sdk.createWorker).not.toHaveBeenCalled();
  });
});

describe('local OCR lifecycle', () => {
  it('uses only same-origin asset URLs, returns text, and releases resources', async () => {
    const worker = makeWorker();
    sdk.createWorker.mockResolvedValue(worker);
    const progress: number[] = [];
    await expect(recognizeScreenshot(file(), { onProgress: p => progress.push(p.progress) })).resolves.toContain('取出: 2 本');
    expect(sdk.createWorker).toHaveBeenCalledWith(['jpn', 'eng'], 1, expect.objectContaining({
      workerPath: 'https://example.test/ocr/worker.min.js', corePath: 'https://example.test/ocr/core', langPath: 'https://example.test/ocr/lang', workerBlobURL: false,
    }));
    expect(worker.recognize).toHaveBeenCalledWith(bitmap, {}, { text: true });
    expect(worker.terminate).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-image');
    expect(bitmap.width).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1]))).toBe(true);
  });
  it('honors an already-cancelled signal without decoding', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(recognizeScreenshot(file(), { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('cancels immediately while recognition is pending and permits a fresh run', async () => {
    const worker = makeWorker();
    worker.recognize.mockReturnValue(new Promise(() => {}));
    sdk.createWorker.mockResolvedValue(worker);
    const abort = new AbortController();
    const reading = recognizeScreenshot(file(), { signal: abort.signal });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalled());
    abort.abort(); await rejected;
    expect(worker.terminate).toHaveBeenCalled();
    sdk.createWorker.mockResolvedValue(makeWorker());
    await expect(recognizeScreenshot(file())).resolves.toContain('取出');
  });
  it('cleans up a worker that becomes ready after cancellation during initialization', async () => {
    const worker = makeWorker();
    let ready!: (value: typeof worker) => void;
    sdk.createWorker.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const abort = new AbortController();
    const reading = recognizeScreenshot(file(), { signal: abort.signal });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(sdk.createWorker).toHaveBeenCalled());
    abort.abort(); await rejected;
    ready(worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalled());
    expect(worker.recognize).not.toHaveBeenCalled();
  });
  it('times out instead of waiting forever when the library has no result', async () => {
    const worker = makeWorker();
    worker.recognize.mockReturnValue(new Promise(() => {}));
    sdk.createWorker.mockResolvedValue(worker);
    await expect(recognizeScreenshot(file(), { timeoutMs: 20 })).rejects.toThrow('時間内');
    expect(worker.terminate).toHaveBeenCalled();
  });
  it('surfaces worker initialization errors even if the SDK promise stays pending', async () => {
    sdk.createWorker.mockImplementation((_languages, _mode, options) => {
      queueMicrotask(() => options.errorHandler('load failed'));
      return new Promise(() => {});
    });
    await expect(recognizeScreenshot(file())).rejects.toThrow('オンライン');
  });
});
