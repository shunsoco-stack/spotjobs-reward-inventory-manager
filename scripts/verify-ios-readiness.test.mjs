import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));
let fixture;
const write = (name, content) => {
  const path = join(fixture, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const copy = (source, destination = source) => {
  const path = join(fixture, destination);
  mkdirSync(dirname(path), { recursive: true });
  cpSync(join(repository, source), path, { recursive: true });
};
const config = {
  appId: 'com.shunsoco.spotjobsmanager', appName: 'ワークストック', webDir: 'out',
  packageClassList: ['FilesystemPlugin', 'InAppBrowserPlugin', 'SharePlugin'],
};
const native = 'ios/App/App';
const ocr = ['ocr/worker.min.js', 'ocr/lang/jpn.traineddata.gz', 'ocr/lang/eng.traineddata.gz', 'ocr/core.js', 'ocr/core.wasm'];

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'ios-readiness-test-'));
  for (const name of ['package.json', 'package-lock.json', 'capacitor.config.ts', 'next.config.ts', 'assets', 'scripts/verify-ios-readiness.mjs', 'scripts/ios-release-preflight.mjs', 'ios/App/App.xcodeproj', `${native}/Info.plist`, `${native}/PrivacyInfo.xcprivacy`, `${native}/Assets.xcassets`]) copy(name);
  write('out/index.html', '<title>ワークストック｜報酬と在庫</title>');
  write('out/privacy.html', 'プライバシーポリシー');
  write('out/support.html', 'サポート');
  write('out/sw.js', '// fixture');
  copy('assets/app-icon-1024.png', 'out/icon.png');
  write('out/manifest.webmanifest', JSON.stringify({
    name: 'ワークストック｜報酬と在庫', short_name: 'ワークストック', display: 'standalone',
    icons: [{ src: '/icon.png', sizes: '1024x1024' }, { src: '/icon.png', sizes: '1024x1024' }],
  }));
  for (const name of ocr) write(`out/${name}`, 'fixture asset');
  write('out/ocr/manifest.json', JSON.stringify({ version: 'fixture', assets: ocr }));
  const git = spawnSync('git', ['init', '--quiet'], { cwd: fixture, encoding: 'utf8' });
  expect(git.status, git.stderr).toBe(0);
  // The verifier runs git diff --check HEAD as well as the secret scan.
  const commit = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: fixture, encoding: 'utf8' });
  expect(commit.status, commit.stderr).toBe(0);
});

afterEach(() => {
  if (fixture && resolve(fixture).startsWith(`${resolve(tmpdir())}${sep}ios-readiness-test-`)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function verify(required = false) {
  const result = spawnSync(process.execPath, ['scripts/verify-ios-readiness.mjs', ...(required ? ['--require-native'] : [])], { cwd: fixture, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

function generate() {
  write(`${native}/capacitor.config.json`, JSON.stringify(config));
  cpSync(join(fixture, 'out'), join(fixture, native, 'public'), { recursive: true });
}

describe('iOS readiness on a committed native project', () => {
  it('checks committed inputs and reports absent ignored outputs as INFO', () => {
    const result = verify();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('13 passed, 2 informational, 0 failed');
    expect(result.output).toContain('INFO  Generated native configuration');
    expect(result.output).toContain('INFO  Synced native web bundle');
    expect(result.output).toContain('npm run ios:verify-native (--require-native)');
  });

  it('requires both generated outputs with --require-native', () => {
    const result = verify(true);
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAIL  Generated native configuration');
    expect(result.output).toContain('FAIL  Synced native web bundle');
  });

  it.each([false, true])('accepts valid generated outputs (required=%s)', required => {
    generate();
    const result = verify(required);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('15 passed, 0 informational, 0 failed');
  });

  it.each([
    ['stale appId', () => write(`${native}/capacitor.config.json`, JSON.stringify({ ...config, appId: 'invalid' })), 'Generated native configuration'],
    ['stale appName', () => write(`${native}/capacitor.config.json`, JSON.stringify({ ...config, appName: 'invalid' })), 'Generated native configuration'],
    ['stale webDir', () => write(`${native}/capacitor.config.json`, JSON.stringify({ ...config, webDir: 'invalid' })), 'Generated native configuration'],
    ['missing plugin', () => write(`${native}/capacitor.config.json`, JSON.stringify({ ...config, packageClassList: [] })), 'Generated native configuration'],
    ['malformed config', () => write(`${native}/capacitor.config.json`, '{'), 'Generated native configuration'],
    ['stale index', () => write(`${native}/public/index.html`, 'stale'), 'Synced native web bundle'],
    ['missing OCR', () => rmSync(join(fixture, native, 'public', ocr[0])), 'Synced native web bundle'],
  ])('rejects %s even without --require-native', (_label, corrupt, failure) => {
    generate();
    corrupt();
    for (const required of [false, true]) {
      const result = verify(required);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`FAIL  ${failure}`);
    }
  });

  it('still checks committed identity when generated outputs are absent', () => {
    write(`${native}/Info.plist`, '<plist/>');
    const result = verify();
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAIL  Native display name');
  });

  it('does not treat a partially copied web directory as absent', () => {
    mkdirSync(join(fixture, native, 'public'));
    const result = verify();
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAIL  Synced native web bundle');
  });

  it('plans sync and native verification for the existing project', () => {
    const result = spawnSync(process.execPath, ['scripts/ios-release-preflight.mjs', '--plan'], { cwd: fixture, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Synchronize existing iOS project');
    expect(result.stdout).toContain('sync ios');
    expect(result.stdout).toContain('ios:verify-native');
    expect(result.stdout).toContain('Build an unsigned Debug app');
    expect(result.stdout).not.toContain('--ci-ephemeral');
    const personal = result.stdout.indexOf('NEXT_PUBLIC_ENABLE_SYNC=1');
    const release = result.stdout.indexOf('NEXT_PUBLIC_ENABLE_SYNC=0');
    const releaseCheck = result.stdout.indexOf('playwright.release.config.ts');
    const sync = result.stdout.indexOf('sync ios');
    expect(personal).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(personal);
    expect(releaseCheck).toBeGreaterThan(release);
    expect(sync).toBeGreaterThan(releaseCheck);
    expect(readFileSync(join(repository, '.github/workflows/ios-native.yml'), 'utf8')).not.toContain('--ci-ephemeral');
  });
});
