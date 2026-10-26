import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Reuse WXT's locked ZIP implementation. Package the tested files without
// rebuilding them, then read the ZIP back and compare every file byte for byte.
const requireWxt = createRequire(await realpath('node_modules/wxt/package.json'));
const JSZip = requireWxt('jszip');
const root = path.resolve('.output/chrome-mv3');
const removalStage = process.argv.includes('--removal-stage');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.version, pkg.version);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function list(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    assert(!entry.isSymbolicLink(), 'Build output must not contain symlinks');
    return entry.isDirectory() ? list(path.join(dir, entry.name)) : [path.join(dir, entry.name)];
  }));
  return groups.flat().sort();
}
const files = await list(root);
const zip = new JSZip();
const records = [];
for (const file of files) {
  const name = path.relative(root, file).split(path.sep).join('/');
  const bytes = await readFile(file);
  zip.file(name, bytes, { date: new Date('2026-01-01T00:00:00Z') });
  records.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
}
const packed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
const zipPath = `.output/${pkg.name}-${pkg.version}${removalStage ? '-no-extraction' : ''}-chrome.zip`;
await writeFile(zipPath, packed);
const reopened = await JSZip.loadAsync(await readFile(zipPath));
assert.deepEqual(Object.values(reopened.files).filter(item => !item.dir).map(item => item.name).sort(), records.map(item => item.path).sort());
for (const item of records) {
  assert.equal(hash(await reopened.file(item.path).async('nodebuffer')), item.sha256);
  assert.equal(hash(await readFile(path.join(root, item.path))), item.sha256, 'Build changed during packaging');
}
const baseline = JSON.parse((await readFile('docs/P0_BASELINE_ARTIFACT.json', 'utf8')).replace(/^\uFEFF/, ''));
const unpackedBytes = records.reduce((sum, item) => sum + item.bytes, 0);
const report = {
  file: zipPath, sizeBytes: packed.length, sha256: hash(packed), unpackedBytes,
  manifestVersion: manifest.manifest_version, version: manifest.version, builtFiles: files.length,
  baseline: { version: baseline.version, unpackedBytes: baseline.unpackedBytes, zipBytes: baseline.zipBytes },
  delta: { unpackedBytes: unpackedBytes - baseline.unpackedBytes, zipBytes: packed.length - baseline.zipBytes },
  zipFilesVerified: true, files: records,
};
await writeFile(removalStage ? 'docs/NO_EXTRACTION_ARTIFACT.json' : 'docs/BUILD_ARTIFACT.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
