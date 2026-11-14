import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';

// Next.js 16.4.2's build writers create parent and nested output directories
// concurrently. On some Windows/OneDrive filesystems those recursive mkdir
// pairs intermittently fail with EPERM. Its cleanup can also fail when OneDrive
// leaves an empty generated build-id directory marked ReadOnly. This preload is
// restricted to this project's `.next` and `out` build artifacts; every other
// path and OS is untouched. Remove it after Next.js sequences output directory
// creation, tolerates these empty ReadOnly directories, and two clean Windows
// builds pass without the preload.
if (process.platform === 'win32') {
  const projectRoot = resolve(process.cwd());
  const generatedRoots = [resolve(projectRoot, '.next'), resolve(projectRoot, 'out')];
  const generatedEmptyDirectoryPatterns = [
    /^\.next\/static\/[A-Za-z0-9_-]{8,}$/,
    /^out\/_next\/[A-Za-z0-9_-]{8,}$/,
    /^out\/_next\/static\/[A-Za-z0-9_-]{8,}$/,
  ];
  const originalMkdir = fs.promises.mkdir.bind(fs.promises);
  const originalRm = fs.promises.rm.bind(fs.promises);
  const originalRmdirSync = fs.rmdirSync.bind(fs);
  let mkdirQueue = Promise.resolve();

  fs.promises.mkdir = (path, options) => {
    const absolutePath = typeof path === 'string' ? resolve(path) : null;
    const isGeneratedPath = absolutePath !== null && generatedRoots.some((root) => {
      const pathFromRoot = relative(root, absolutePath);
      return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
    });

    if (!isGeneratedPath) {
      return originalMkdir(path, options);
    }

    const result = mkdirQueue.then(() => originalMkdir(path, options));
    mkdirQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const unlockEmptyGeneratedDirectory = (path) => {
    if (typeof path !== 'string') return false;

    const absolutePath = resolve(path);
    const pathFromProject = relative(projectRoot, absolutePath).replaceAll('\\', '/');
    if (!generatedEmptyDirectoryPatterns.some((pattern) => pattern.test(pathFromProject))) {
      return false;
    }

    try {
      const stats = fs.lstatSync(absolutePath);
      if (!stats.isDirectory() || stats.isSymbolicLink() || fs.readdirSync(absolutePath).length !== 0) {
        return false;
      }
      fs.chmodSync(absolutePath, stats.mode | 0o222);
      return true;
    } catch {
      return false;
    }
  };

  fs.rmdirSync = (path, options) => {
    try {
      return originalRmdirSync(path, options);
    } catch (error) {
      const failedPath = error && typeof error === 'object' && 'path' in error ? error.path : path;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EPERM' &&
        unlockEmptyGeneratedDirectory(failedPath)
      ) {
        return originalRmdirSync(path, options);
      }
      throw error;
    }
  };

  fs.promises.rm = async (path, options) => {
    const maxUnlockRetries = generatedEmptyDirectoryPatterns.length;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await originalRm(path, options);
      } catch (error) {
        const failedPath = error && typeof error === 'object' && 'path' in error ? error.path : undefined;
        if (
          attempt >= maxUnlockRetries ||
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EPERM' ||
          !unlockEmptyGeneratedDirectory(failedPath)
        ) {
          throw error;
        }
      }
    }
  };

  // `recursive-delete` imports `rmdirSync` as an ESM named export. Reflect the
  // patched CommonJS default export before the Next.js entry point is loaded.
  syncBuiltinESMExports();
}
