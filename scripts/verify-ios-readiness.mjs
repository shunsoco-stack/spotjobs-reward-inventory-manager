import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireNative = process.argv.includes('--require-native');
const passes = [];
const notes = [];
const failures = [];

const display = path => relative(root, path).replaceAll('\\', '/');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = (label, action) => {
  try {
    const detail = action();
    passes.push(detail ? `${label}: ${detail}` : label);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const readText = path => readFileSync(path, 'utf8');
const readJson = path => JSON.parse(readText(path));
const nonEmpty = path => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function pngInfo(path) {
  const bytes = readFileSync(path);
  assert(bytes.length >= 33, `${display(path)} is too small to be a PNG`);
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${display(path)} has an invalid PNG signature`);
  assert(bytes.subarray(12, 16).toString('ascii') === 'IHDR', `${display(path)} has no IHDR chunk`);
  let offset = 8;
  let hasTransparencyChunk = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    assert(offset + length + 12 <= bytes.length, `${display(path)} has a truncated ${type} chunk`);
    if (type === 'tRNS') hasTransparencyChunk = true;
    offset += length + 12;
    if (type === 'IEND') break;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    hasAlpha: bytes[25] === 4 || bytes[25] === 6 || hasTransparencyChunk,
  };
}

function literalProperty(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*:\\s*(['\"])(.*?)\\1`));
  return match?.[2];
}

const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function assertPrivacyManifest(path) {
  const source = readText(path);
  for (const value of ['NSPrivacyAccessedAPITypes', 'NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPITypeReasons', 'C617.1']) {
    assert(source.includes(value), `${display(path)} is missing ${value}`);
  }
}

check('Node.js toolchain', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert(major >= 22, `Node.js 22 or newer is required; found ${process.version}`);
  return process.version;
});

const packagePath = join(root, 'package.json');
const lockPath = join(root, 'package-lock.json');
const packageJson = readJson(packagePath);
const packageLock = readJson(lockPath);
check('Pinned Capacitor packages and npm commands', () => {
  const expected = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/filesystem', '@capacitor/inappbrowser', '@capacitor/share'];
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const name of expected) {
    assert(/^\d+\.\d+\.\d+$/.test(declared[name] ?? ''), `${name} must be pinned to an exact version`);
    const lockVersion = packageLock.packages?.['']?.dependencies?.[name] ?? packageLock.packages?.['']?.devDependencies?.[name];
    assert(lockVersion === declared[name], `${name} differs between package.json and package-lock.json`);
  }
  const capacitorMajors = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios'].map(name => Number(declared[name].split('.')[0]));
  assert(capacitorMajors.every(major => major === capacitorMajors[0] && major >= 8), 'Capacitor core, CLI, and iOS must use the same supported major');
  for (const script of ['build', 'ios:add', 'ios:sync', 'ios:prepare-assets', 'ios:verify-native', 'ios:release-preflight']) {
    assert(typeof packageJson.scripts?.[script] === 'string', `npm script ${script} is missing`);
  }
  return `Capacitor ${declared['@capacitor/core']}`;
});

const capacitorPath = join(root, 'capacitor.config.ts');
const capacitorSource = readText(capacitorPath);
const appId = literalProperty(capacitorSource, 'appId');
const appName = literalProperty(capacitorSource, 'appName');
const webDir = literalProperty(capacitorSource, 'webDir');
check('Capacitor local-bundle configuration', () => {
  assert(/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*){2,}$/.test(appId ?? ''), `invalid appId ${String(appId)}`);
  assert(typeof appName === 'string' && appName.trim().length > 0, 'appName must not be empty');
  assert(webDir === 'out', `webDir must be out; found ${String(webDir)}`);
  assert(!/\bserver\s*:\s*\{[\s\S]*?\burl\s*:/.test(capacitorSource), 'server.url would turn the app into a remote website wrapper');
  assert(!/\ballowNavigation\s*:/.test(capacitorSource), 'allowNavigation must not expose remote origins inside the app WebView');
  assert(!/\bcleartext\s*:\s*true\b/.test(capacitorSource), 'cleartext traffic must not be enabled');
  return `${appId}; bundled ${webDir}/ assets`;
});

check('Next.js static export configuration', () => {
  const source = readText(join(root, 'next.config.ts'));
  assert(/\boutput\s*:\s*['\"]export['\"]/.test(source), 'next.config.ts must use output: export');
  return 'output: export';
});

const out = join(root, 'out');
check('Static export and legal routes', () => {
  const required = ['index.html', 'privacy.html', 'support.html', 'manifest.webmanifest', 'sw.js'];
  for (const name of required) assert(nonEmpty(join(out, name)), `run npm run build; ${display(join(out, name))} is missing or empty`);
  assert(readText(join(out, 'privacy.html')).includes('プライバシーポリシー'), 'privacy.html has no privacy policy heading');
  assert(readText(join(out, 'support.html')).includes('サポート'), 'support.html has no support heading');
  const indexHtml = readText(join(out, 'index.html'));
  const documentTitle = indexHtml.match(/<title>(.*?)<\/title>/)?.[1];
  assert(documentTitle === appName, `HTML title ${String(documentTitle)} differs from Capacitor appName ${String(appName)}`);
  assert(!/<script\b[^>]*\bsrc\s*=\s*['\"]https?:\/\//i.test(indexHtml), 'index.html loads a remote script and cannot guarantee offline native startup');
  return required.join(', ');
});

check('PWA manifest and icon files', () => {
  const manifest = readJson(join(out, 'manifest.webmanifest'));
  assert(manifest.name === appName, `manifest app name ${String(manifest.name)} differs from Capacitor appName ${String(appName)}`);
  assert(manifest.display === 'standalone', 'manifest display must be standalone');
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'manifest needs installable icons');
  for (const icon of manifest.icons) {
    const path = join(out, String(icon.src).replace(/^\//, ''));
    assert(nonEmpty(path), `manifest icon ${String(icon.src)} is missing`);
    const [width, height] = String(icon.sizes).split('x').map(Number);
    const info = pngInfo(path);
    assert(info.width === width && info.height === height, `${display(path)} dimensions do not match ${icon.sizes}`);
  }
  return manifest.icons.map(icon => icon.sizes).join(', ');
});

const iconSource = join(root, 'assets', 'app-icon-1024.png');
check('App Store icon source', () => {
  const info = pngInfo(iconSource);
  assert(info.width === 1024 && info.height === 1024, `expected 1024x1024; found ${info.width}x${info.height}`);
  assert(info.bitDepth === 8 && info.colorType === 2, `expected opaque 8-bit RGB PNG; found bit depth ${info.bitDepth}, color type ${info.colorType}`);
  assert(!info.hasAlpha, 'App Store icon must not contain alpha or a tRNS chunk');
  return '1024x1024 opaque RGB';
});

const privacyTemplate = join(root, 'assets', 'ios', 'PrivacyInfo.xcprivacy');
check('Privacy manifest template', () => {
  assert(nonEmpty(privacyTemplate), `${display(privacyTemplate)} is missing`);
  assertPrivacyManifest(privacyTemplate);
  return 'File Timestamp / C617.1';
});

check('Bundled OCR runtime', () => {
  const manifestPath = join(out, 'ocr', 'manifest.json');
  assert(nonEmpty(manifestPath), `run npm run build; ${display(manifestPath)} is missing`);
  const manifest = readJson(manifestPath);
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'OCR manifest version is missing');
  assert(Array.isArray(manifest.assets) && manifest.assets.length >= 5, 'OCR manifest asset list is incomplete');
  for (const asset of manifest.assets) assert(nonEmpty(join(out, String(asset).replace(/^\//, ''))), `OCR asset ${asset} is missing or empty`);
  const megabytes = walk(join(out, 'ocr')).reduce((total, path) => total + statSync(path).size, 0) / 1024 / 1024;
  return `${manifest.assets.length} files declared, ${megabytes.toFixed(1)} MB bundled`;
});

check('Committable-file secret and Xcode-state scan', () => {
  const safeRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  const git = spawnSync('git', ['-c', `safe.directory=${safeRoot}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  assert(git.status === 0, git.stderr.trim() || 'git ls-files failed');
  const committable = git.stdout.split('\0').filter(Boolean);
  const prohibitedNames = [/(^|\/)\.env(?:\.|$)/, /\.p8$/i, /\.p12$/i, /\.mobileprovision$/i, /(^|\/)xcuserdata\//i, /(^|\/)DerivedData\//i, /\.xcuserstate$/i];
  const unsafeName = committable.find(name => name !== '.env.example' && prohibitedNames.some(pattern => pattern.test(name)));
  assert(!unsafeName, `prohibited credential or local Xcode file is tracked: ${unsafeName}`);
  const patterns = [
    ['private key', new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join(''))],
    ['GitHub token', new RegExp(['gh', '[pousr]_[A-Za-z0-9]{36,}'].join(''))],
    ['GitHub fine-grained token', new RegExp(['github', '_pat_[A-Za-z0-9_]{20,}'].join(''))],
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ];
  const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.gz', '.wasm', '.zip']);
  for (const name of committable) {
    if (binaryExtensions.has(extname(name).toLowerCase())) continue;
    const path = join(root, name);
    if (!existsSync(path) || statSync(path).size > 5_000_000) continue;
    const source = readText(path);
    const hit = patterns.find(([, pattern]) => pattern.test(source));
    assert(!hit, `${hit?.[0]} pattern found in ${name}`);
  }
  const whitespace = spawnSync('git', ['-c', `safe.directory=${safeRoot}`, 'diff', '--check', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert(whitespace.status === 0, whitespace.stdout.trim() || whitespace.stderr.trim() || 'git diff --check failed');
  return `${committable.length} tracked or untracked non-ignored files scanned`;
});

const ios = join(root, 'ios');
if (!existsSync(ios)) {
  if (requireNative) failures.push('Generated iOS project: ios/ is missing; after the final app identity is approved, run npm run ios:release-preflight -- --identity-confirmed on macOS');
  else notes.push('Native Xcode project is intentionally pending. After the final app name and Bundle ID are approved, run npm run ios:release-preflight -- --identity-confirmed on macOS.');
} else {
  const projectPath = join(ios, 'App', 'App.xcodeproj', 'project.pbxproj');
  const nativeConfigPath = join(ios, 'App', 'App', 'capacitor.config.json');
  const nativeInfoPath = join(ios, 'App', 'App', 'Info.plist');
  const nativePublic = join(ios, 'App', 'App', 'public');
  const nativePrivacy = join(ios, 'App', 'App', 'PrivacyInfo.xcprivacy');
  const nativeIcon = join(ios, 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
  check('Generated Xcode project', () => {
    assert(nonEmpty(projectPath), `${display(projectPath)} is missing`);
    const project = readText(projectPath);
    assert(project.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${appId};`), `Xcode bundle identifier does not include ${appId}`);
    const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/g)].map(match => Number(match[1]));
    assert(targets.length > 0 && targets.every(target => target >= 15), 'all iOS deployment targets must be 15.0 or newer');
    assert(project.includes('PrivacyInfo.xcprivacy in Resources'), 'PrivacyInfo.xcprivacy is not in Copy Bundle Resources; run npm run ios:prepare-assets');
    return `${appId}; iOS ${Math.min(...targets).toFixed(1)}+`;
  });
  check('Native display name', () => {
    assert(nonEmpty(nativeInfoPath), `${display(nativeInfoPath)} is missing`);
    const info = readText(nativeInfoPath);
    const displayName = info.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/)?.[1]?.trim();
    assert(displayName === xmlText(appName), `Info.plist display name ${String(displayName)} differs from Capacitor appName ${String(appName)}; cap sync does not update native identity, so update it in Xcode or regenerate the project`);
    return appName;
  });
  check('Generated native configuration', () => {
    const nativeConfig = readJson(nativeConfigPath);
    assert(nativeConfig.appId === appId && nativeConfig.appName === appName && nativeConfig.webDir === webDir, 'generated capacitor.config.json is stale');
    assert(!nativeConfig.server?.url, 'generated native config contains a remote server.url');
    for (const plugin of ['FilesystemPlugin', 'InAppBrowserPlugin', 'SharePlugin']) assert(nativeConfig.packageClassList?.includes(plugin), `${plugin} is missing from the generated native config`);
    return nativeConfig.packageClassList.join(', ');
  });
  check('Native release assets', () => {
    assert(nonEmpty(nativePrivacy), `${display(nativePrivacy)} is missing; run npm run ios:prepare-assets`);
    assertPrivacyManifest(nativePrivacy);
    assert(sha256(nativeIcon) === sha256(iconSource), 'native AppIcon does not match assets/app-icon-1024.png; run npm run ios:prepare-assets');
    return 'custom icon and PrivacyInfo.xcprivacy installed';
  });
  check('Synced native web bundle', () => {
    for (const name of ['index.html', 'privacy.html', 'support.html', 'ocr/worker.min.js', 'ocr/lang/jpn.traineddata.gz', 'ocr/lang/eng.traineddata.gz']) {
      assert(nonEmpty(join(nativePublic, ...name.split('/'))), `${display(join(nativePublic, ...name.split('/')))} is missing; run npm run ios:sync`);
    }
    assert(sha256(join(nativePublic, 'index.html')) === sha256(join(out, 'index.html')), 'native index.html is stale; run npm run ios:sync');
    return 'app, legal pages, and offline OCR copied';
  });
}

console.log('\niOS release readiness');
for (const pass of passes) console.log(`PASS  ${pass}`);
for (const note of notes) console.log(`INFO  ${note}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
console.log(`\n${passes.length} passed, ${notes.length} informational, ${failures.length} failed.`);
if (failures.length > 0) process.exitCode = 1;
