import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const planOnly = process.argv.includes('--plan');
const identityConfirmed = process.argv.includes('--identity-confirmed');
const ciEphemeral = process.argv.includes('--ci-ephemeral');
const hadNativeProject = existsSync(join(root, 'ios'));
const artifacts = join(root, '.artifacts');
const reportPath = join(artifacts, 'ios-release-preflight.md');
const projectPath = join(root, 'ios', 'App', 'App.xcodeproj');
const scheme = 'App';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const capacitor = join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
const playwright = join(root, 'node_modules', '@playwright', 'test', 'cli.js');

const display = path => relative(root, path).replaceAll('\\', '/');
const shellLine = (command, args) => [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');

const steps = [];
const record = (label, command, args) => steps.push({ label, command, args });

record('Web quality and cross-platform readiness', npm, ['run', 'ios:preflight']);
record('Install Playwright browsers used by release E2E', process.execPath, [playwright, 'install', 'chromium', 'webkit']);
record('Run release E2E against a local static preview', npm, ['run', 'test:e2e']);
record(
  hadNativeProject ? 'Synchronize existing iOS project' : 'Generate iOS project',
  process.execPath,
  [capacitor, hadNativeProject ? 'sync' : 'add', 'ios'],
);
record('Install release assets', npm, ['run', 'ios:prepare-assets']);
record('Verify generated native project', npm, ['run', 'ios:verify-native']);
record('Resolve Swift Package Manager dependencies', 'xcodebuild', [
  '-project', projectPath,
  '-scheme', scheme,
  '-resolvePackageDependencies',
]);

if (planOnly) {
  console.log('iOS local release preflight plan (no commands were run)\n');
  for (const [index, step] of steps.entries()) console.log(`${index + 1}. ${step.label}\n   ${shellLine(step.command, step.args)}`);
  console.log(`${steps.length + 1}. Lint source and generated Privacy Manifests with plutil`);
  console.log(`${steps.length + 2}. Build an unsigned Debug app for a generic iOS Simulator in a temporary DerivedData directory`);
  console.log(`${steps.length + 3}. Verify App.app contains PrivacyInfo.xcprivacy and write ${display(reportPath)}`);
  if (!hadNativeProject) console.log('\nA fresh local project also requires --identity-confirmed after the final app name and Bundle ID have been approved. GitHub Actions uses --ci-ephemeral on its disposable checkout.');
  process.exit(0);
}

if (process.platform !== 'darwin') {
  throw new Error('ios:release-preflight requires macOS with Xcode. Use --plan to inspect the workflow without running it.');
}

if (!existsSync(capacitor)) {
  throw new Error('Capacitor CLI is missing. Run npm ci before npm run ios:release-preflight.');
}

if (ciEphemeral && (process.env.CI !== 'true' || hadNativeProject)) {
  throw new Error('--ci-ephemeral is reserved for CI=true on a clean checkout without ios/.');
}

if (!hadNativeProject && !identityConfirmed && !ciEphemeral) {
  throw new Error(
    'Refusing to create a persistent Xcode project before the final app name and Bundle ID are confirmed. ' +
    'After that decision, run `npm run ios:release-preflight -- --identity-confirmed`. ' +
    'Use `--plan` to inspect the workflow without writing files.',
  );
}

// A failed rerun must not leave an earlier PASS report looking current.
rmSync(reportPath, { force: true });

const run = (label, command, args, options = {}) => {
  console.log(`\n==> ${label}\n${shellLine(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
    throw new Error(`${label} failed with exit code ${String(result.status)}${detail ? `\n${detail}` : ''}`);
  }
  return options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
};

const capture = (command, args) => run(shellLine(command, args), command, args, { capture: true });

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.unref();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : undefined;
    server.close(error => error ? reject(error) : resolvePort(port));
  });
});

const waitForPreview = async (url, processHandle) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error(`Static preview exited before becoming ready (exit ${String(processHandle.exitCode)}, signal ${String(processHandle.signalCode)}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview process may still be starting.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`Static preview did not become ready at ${url} within 15 seconds.`);
};

const waitForProcessExit = (processHandle, timeoutMs) => {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      processHandle.off('exit', onExit);
      resolveExit(processHandle.exitCode !== null || processHandle.signalCode !== null);
    }, timeoutMs);
    processHandle.once('exit', onExit);
  });
};

const stopPreview = async () => {
  if (!previewProcess) return;
  const processHandle = previewProcess;
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill('SIGTERM');
    if (!(await waitForProcessExit(processHandle, 5_000))) {
      processHandle.kill('SIGKILL');
      if (!(await waitForProcessExit(processHandle, 5_000))) {
        throw new Error(`Static preview process ${String(processHandle.pid)} did not stop.`);
      }
    }
  }
  previewProcess = undefined;
};

const xcodeVersion = capture('xcodebuild', ['-version']);
const xcodeMajor = Number(xcodeVersion.match(/Xcode\s+(\d+)/)?.[1]);
if (!Number.isFinite(xcodeMajor) || xcodeMajor < 26) {
  throw new Error(`Xcode 26 or newer is required; found:\n${xcodeVersion}`);
}

let derivedData;
let previewProcess;
let primaryError;
try {
  run(steps[0].label, steps[0].command, steps[0].args);
  run(steps[1].label, steps[1].command, steps[1].args);

  const previewPort = await reservePort();
  const previewUrl = `http://127.0.0.1:${previewPort}`;
  previewProcess = spawn(process.execPath, ['scripts/preview.mjs'], {
    cwd: root,
    env: { ...process.env, PREVIEW_HOST: '127.0.0.1', PREVIEW_PORT: String(previewPort) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForPreview(previewUrl, previewProcess);
  run(steps[2].label, steps[2].command, steps[2].args, { env: { E2E_BASE_URL: previewUrl } });
  await stopPreview();

  for (const step of steps.slice(3, 6)) run(step.label, step.command, step.args);

  if (!existsSync(projectPath)) throw new Error(`${display(projectPath)} was not generated.`);
  run(steps[6].label, steps[6].command, steps[6].args);
  run('Lint source and generated Privacy Manifests', 'plutil', [
    '-lint',
    join(root, 'assets', 'ios', 'PrivacyInfo.xcprivacy'),
    join(root, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy'),
  ]);

  const tempBase = resolve(process.env.RUNNER_TEMP || tmpdir());
  derivedData = await mkdtemp(join(tempBase, 'spotjobs-ios-preflight-'));
  const buildArgs = [
    '-project', projectPath,
    '-scheme', scheme,
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', derivedData,
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'build',
  ];
  run('Build unsigned generic iOS Simulator application', 'xcodebuild', buildArgs);

  const appBundle = join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
  if (!existsSync(appBundle) || !statSync(appBundle).isDirectory()) {
    throw new Error(`Expected simulator bundle was not produced at ${appBundle}`);
  }
  const bundledPrivacy = join(appBundle, 'PrivacyInfo.xcprivacy');
  if (!existsSync(bundledPrivacy) || !statSync(bundledPrivacy).isFile()) {
    throw new Error(`Built application is missing ${bundledPrivacy}`);
  }
  run('Lint the Privacy Manifest embedded in App.app', 'plutil', ['-lint', bundledPrivacy]);

  const settings = capture('xcodebuild', [
    '-project', projectPath,
    '-scheme', scheme,
    '-configuration', 'Release',
    '-showBuildSettings',
  ]);
  const setting = name => settings.match(new RegExp(`^\\s*${name} = (.*)$`, 'm'))?.[1]?.trim() || 'not set';
  const gitCommit = capture('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD']);
  const gitStatus = capture('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'status', '--short']);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const timestamp = new Date().toISOString();

  mkdirSync(artifacts, { recursive: true });
  const report = `# iOS local release preflight\n\n` +
    `- Completed: ${timestamp}\n` +
    `- Result: PASS\n` +
    `- Git commit: \`${gitCommit}\`\n` +
    `- Working tree: ${gitStatus ? 'has local changes (listed below)' : 'clean'}\n` +
    `- Node.js: ${process.version}\n` +
    `- Xcode: ${xcodeVersion.replaceAll('\n', ' / ')}\n` +
    `- Capacitor: ${packageJson.dependencies['@capacitor/core']}\n` +
    `- Product bundle identifier: \`${setting('PRODUCT_BUNDLE_IDENTIFIER')}\`\n` +
    `- Marketing version: \`${setting('MARKETING_VERSION')}\`\n` +
    `- Build number: \`${setting('CURRENT_PROJECT_VERSION')}\`\n` +
    `- iOS deployment target: \`${setting('IPHONEOS_DEPLOYMENT_TARGET')}\`\n` +
    `- Targeted device family: \`${setting('TARGETED_DEVICE_FAMILY')}\`\n` +
    `- Code sign style: \`${setting('CODE_SIGN_STYLE')}\`\n` +
    `- Development Team: \`${setting('DEVELOPMENT_TEAM')}\`\n\n` +
    `## Verified\n\n` +
    `- lint, typecheck, unit tests, static export, local production E2E, and cross-platform iOS readiness\n` +
    `- Capacitor add or sync and idempotent native asset preparation\n` +
    `- native display name, Bundle ID, plugins, Privacy Manifest, AppIcon, legal pages, and bundled OCR assets\n` +
    `- Swift Package Manager resolution\n` +
    `- unsigned generic iOS Simulator build, App.app output, and embedded Privacy Manifest\n\n` +
    `This preflight does not sign, archive, upload, register a Bundle ID, access Apple credentials, or replace real-device/TestFlight/App Store validation.\n` +
    (gitStatus ? `\n## Working tree changes\n\n\`\`\`text\n${gitStatus}\n\`\`\`\n` : '');
  writeFileSync(reportPath, report, 'utf8');

  console.log(`\nPASS: local iOS release preflight completed.`);
  console.log(`Report: ${display(reportPath)}`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  let cleanupError;
  try {
    await stopPreview();
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (derivedData) {
      const tempBase = resolve(process.env.RUNNER_TEMP || tmpdir());
      const target = resolve(derivedData);
      if (target.startsWith(`${tempBase}${sep}`) && target.includes('spotjobs-ios-preflight-')) {
        rmSync(target, { recursive: true, force: true });
      }
    }
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    if (primaryError) console.error(`Cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    else throw cleanupError;
  }
}
