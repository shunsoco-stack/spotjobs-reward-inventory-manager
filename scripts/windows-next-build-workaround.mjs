import fs from 'node:fs';

// Next.js 16.4.2's build writers create parent and nested output directories
// concurrently. On some Windows/OneDrive filesystems those recursive mkdir
// pairs intermittently fail with EPERM (`.segments` and final `out` routes have
// both reproduced it). This preload runs only for the build process and makes
// Windows mkdir calls sequential; every other OS is untouched. Remove it after
// Next.js sequences output directory creation and two clean Windows builds pass.
if (process.platform === 'win32') {
  const originalMkdir = fs.promises.mkdir.bind(fs.promises);
  let mkdirQueue = Promise.resolve();

  fs.promises.mkdir = (path, options) => {
    const result = mkdirQueue.then(() => originalMkdir(path, options));
    mkdirQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
