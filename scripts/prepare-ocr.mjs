import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const JAPANESE_SOURCE_SHA256 = '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88';
const OMITTED_CONFIG_KEYS = new Set([
  'tessedit_load_sublangs', // jpn_vert is intentionally not bundled: horizontal screenshots only.
  'language_model_ngram_on', 'segsearch_max_char_wh_ratio',
  'language_model_ngram_space_delimited_language', 'language_model_ngram_scale_factor',
  'language_model_use_sigmoidal_certainty', 'language_model_ngram_nonmatch_score',
  'classify_integer_matcher_multiplier', 'assume_fixed_pitch_char_segment',
  'chop_enable', 'allow_blob_division',
]);

// The pinned Japanese model contains legacy-engine configuration that is absent
// from the LSTM-only core. Rewrite only its config component, not its learned
// data. This follows TessdataManager's offset-table format:
// https://github.com/tesseract-ocr/tesseract/blob/main/src/ccutil/tessdatamanager.cpp
// Any npm model/layout/config change fails closed and needs an explicit review.
function compatibleJapaneseModel(compressed) {
  if (sha256(compressed) !== JAPANESE_SOURCE_SHA256) throw new Error('Japanese OCR model checksum changed; review the source before updating.');
  const raw = gunzipSync(compressed);
  const count = raw.readInt32LE(0);
  if (count !== 24) throw new Error('Unexpected Japanese OCR model component count.');
  const offsets = Array.from({ length: count }, (_, i) => Number(raw.readBigInt64LE(4 + i * 8)));
  const start = offsets[0];
  const end = offsets.find((value, i) => i > 0 && value >= 0);
  if (start !== 196 || end !== 2759) throw new Error('Unexpected Japanese OCR config offsets.');
  const found = new Set();
  const lines = raw.subarray(start, end).toString('utf8').split('\n');
  const config = Buffer.from(lines.filter(line => {
    const key = line.trim().split(/\s+/)[0];
    if (!OMITTED_CONFIG_KEYS.has(key)) return true;
    if (found.has(key)) throw new Error('Duplicate Japanese OCR config key.');
    found.add(key);
    return false;
  }).join('\n'));
  if (found.size !== OMITTED_CONFIG_KEYS.size) throw new Error('Japanese OCR legacy config changed.');
  const delta = config.length - (end - start);
  if (delta !== -422) throw new Error('Unexpected Japanese OCR config edit.');
  const edited = Buffer.concat([raw.subarray(0, start), config, raw.subarray(end)]);
  for (let i = 1; i < count; i++) if (offsets[i] >= 0) edited.writeBigInt64LE(BigInt(offsets[i] + delta), 4 + i * 8);
  // Verify every present non-config section byte-for-byte after recalculating
  // offsets, including LSTM weights, dictionaries, character set and version.
  for (let i = 1; i < count; i++) {
    if (offsets[i] < 0) continue;
    const next = offsets.find((value, index) => index > i && value >= 0) ?? raw.length;
    if (!raw.subarray(offsets[i], next).equals(edited.subarray(offsets[i] + delta, next + delta))) {
      throw new Error(`Japanese OCR learned data changed in component ${i}.`);
    }
  }
  return gzipSync(edited, { level: 9 });
}

// Only npm package assets are copied. Screenshots and recognized text never enter
// public/, a build output, or this manifest.
const require = createRequire(import.meta.url);
const output = fileURLToPath(new URL('../public/ocr/', import.meta.url));
const sources = [];
const packageDir = name => dirname(require.resolve(`${name}/package.json`));
sources.push([join(packageDir('tesseract.js'), 'dist/worker.min.js'), 'worker.min.js']);
const core = packageDir('tesseract.js-core');
for (const file of (await readdir(core)).sort()) {
  if (/^tesseract-core.*\.wasm(?:\.js)?$/.test(file)) sources.push([join(core, file), `core/${file}`]);
}
for (const language of ['jpn', 'eng']) {
  sources.push([join(packageDir(`@tesseract.js-data/${language}`), `4.0.0_best_int/${language}.traineddata.gz`), `lang/${language}.traineddata.gz`]);
  sources.push([join(packageDir(`@tesseract.js-data/${language}`), 'package.json'), `licenses/${language}-package.json`]);
}
for (const [name, license] of [['tesseract.js', 'LICENSE.md'], ['tesseract.js-core', 'LICENSE']]) sources.push([join(packageDir(name), license), `licenses/${name}.txt`]);
sources.push([fileURLToPath(new URL('licenses/tessdata-APACHE-2.0.txt', import.meta.url)), 'licenses/tessdata-APACHE-2.0.txt']);
sources.push([fileURLToPath(new URL('licenses/ocr-models-NOTICE.txt', import.meta.url)), 'licenses/ocr-models-NOTICE.txt']);
const hash = createHash('sha256');
let total = 0;
let japaneseOutputSha256;
for (const [source, relative] of sources) {
  let bytes = await readFile(source);
  if (relative === 'lang/jpn.traineddata.gz') {
    bytes = compatibleJapaneseModel(bytes);
    japaneseOutputSha256 = sha256(bytes);
  }
  hash.update(relative).update(bytes);
  total += bytes.byteLength;
  const destination = join(output, relative);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
const provenance = Buffer.from(JSON.stringify({ compatibility: 'cjkcompat1', source: '@tesseract.js-data/jpn@1.0.0/4.0.0_best_int', originalSha256: JAPANESE_SOURCE_SHA256, outputSha256: japaneseOutputSha256, removedConfigKeys: [...OMITTED_CONFIG_KEYS], nonConfigComponentsByteIdentical: true }, null, 2) + '\n');
await writeFile(join(output, 'licenses/jpn-model-build.json'), provenance);
hash.update('licenses/jpn-model-build.json').update(provenance);
const version = hash.digest('hex').slice(0, 16);
await writeFile(join(output, 'manifest.json'), JSON.stringify({ version, assets: [...sources.map(([, name]) => `/ocr/${name}`), '/ocr/licenses/jpn-model-build.json'] }, null, 2) + '\n');
console.log(`Local OCR assets ready: ${sources.length + 1} files, ${((total + provenance.length) / 1024 / 1024).toFixed(1)} MB on disk (${version}). Loaded on demand, not precached.`);
