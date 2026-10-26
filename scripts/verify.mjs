import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const checks = [
  ['TypeScript', 'node_modules/typescript/bin/tsc', '--noEmit'],
  ['Vitest', 'node_modules/vitest/vitest.mjs', 'run'],
  ['Chrome MV3 production build', 'node_modules/wxt/bin/wxt.mjs', 'build', '-b', 'chrome'],
];
// Only the requested cover image is read from an authorized current page.
// Keep all other enrichment removed, including schema-1 description/summary UI.
for (const removed of ['src/extractors', 'src/services/extraction.service.ts', 'src/models/extraction.ts']) {
  assert(!existsSync(removed), `Removed extraction code returned: ${removed}`);
}
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
}
for (const file of [...sourceFiles('src'), ...sourceFiles('entrypoints')].filter(file => /\.[jt]sx?$/.test(file))) {
  const code = readFileSync(file, 'utf8');
  assert(!/REFRESH_CURRENT_METADATA|collectPageSnapshot|application\/ld\+json|og:description|twitter:description|Readability|new\s+ExtractionService/.test(code), `Content extraction path found: ${file}`);
  assert(!/\b(?:document|doc)\.(?:body|documentElement)\.(?:innerText|textContent|innerHTML|outerHTML)\b/.test(code), `Full-page content read found: ${file}`);
  const coverReader = file === resolve('src/cover/read-cover.ts');
  assert(coverReader || !/og:image|twitter:image/.test(code), `Cover metadata may only be read by the cover-only reader: ${file}`);
  if (coverReader) {
    assert(!/\b(?:innerText|textContent|innerHTML|outerHTML|cloneNode|documentElement)\b|\b(?:doc|document)\.(?:title|body)\b|description|ldJson|JSON\.parse/.test(code), `Cover reader must not read page text or structured content: ${file}`);
  }
  assert(!/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/.test(code), `Product network client found: ${file}`);
}
for (const [label, script, ...args] of checks) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const root = resolve('.output/chrome-mv3');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.host_permissions, ['https://www.bilibili.com/*']);
assert.deepEqual([...(manifest.optional_host_permissions ?? [])].sort(), ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*', 'https://x.com/*'].sort());
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'bookmarks', 'notifications', 'scripting', 'storage']);
assert(manifest.background.service_worker);
assert(manifest.action.default_popup);
assert(manifest.options_ui?.page);
assert.equal(manifest.content_scripts?.length, 1);
assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.bilibili.com/video/*']);
assert(!manifest.content_scripts[0].all_frames);
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, 'dashboard.html', 'zhihu.js', 'x.js', ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(script => script.js)]) {
  assert(existsSync(resolve(root, file)), `Missing build file: ${file}`);
}
console.log('\nProduction package structure and minimum permission checks passed. Browser acceptance remains separate.');
