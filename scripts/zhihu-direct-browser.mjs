import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir, mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileRoot = path.join(repo, '.browser-test-profile');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repo, '.cache-browser');
const regression = process.argv.includes('--expect-regression');
const url = 'https://www.zhihu.com/question/2096699914101187618/answer/2097401882574591186';
const report = { kind: 'permission-granted-fixed-HTML-direct-toggle', liveSiteTested: false, optionalPermissionPromptTested: false, checks: [], startedAt: new Date().toISOString() };
let run; let context;
async function poll(read, accept) { for (let i = 0; i < 60; i++) { const value = await read(); if (accept(value)) return value; await delay(100); } throw new Error('一键收藏样例等待超时'); }
// Only button/answer-URL structure was observed live. Rollback/dialog variants
// are synthetic negative cases; no body text, site snapshots or API are used.
const html = `<!doctype html><meta charset="utf-8"><title>固定知乎一键收藏测试</title><div class="ContentItem AnswerItem"><meta itemprop="url" content="${url}"><div class="ContentItem-actions"><button class="Button ContentItem-action" aria-label="收藏">&#8203;51</button></div></div><script>
const button=document.querySelector('button');button.onclick=()=>{
const mode=new URL(location.href).searchParams.get('case');
if(mode==='click-only'){button.textContent='52';return;}
setTimeout(()=>{button.setAttribute('aria-label','已收藏');button.textContent='52';},80);
if(mode==='rollback')setTimeout(()=>{button.setAttribute('aria-label','收藏');const toast=document.createElement('div');toast.className='Toast';toast.textContent='收藏失败';document.body.append(toast);},350);
if(mode==='dialog')setTimeout(()=>{const modal=document.createElement('div');modal.className='Modal-content';modal.textContent='添加收藏';document.body.append(modal);},350);
};</script>`;
try {
  await mkdir(profileRoot, { recursive: true }); run = await mkdtemp(path.join(profileRoot, 'run-'));
  const extension = path.join(run, 'extension'); await cp(path.join(repo, '.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = path.join(extension, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestFile, 'utf8')); report.version = manifest.version;
  manifest.host_permissions.push(...manifest.optional_host_permissions); delete manifest.optional_host_permissions;
  await writeFile(manifestFile, JSON.stringify(manifest));
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(path.join(run, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  report.chromiumVersion = context.browser()?.version();
  await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).hostname;
  const page = await context.newPage(); await page.goto(url);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  const request = async message => { const response = await popup.evaluate(value => chrome.runtime.sendMessage(value), message); assert.equal(response?.ok, true, response?.error); return response.data; };
  await request({ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: true } }); await page.bringToFront();
  await poll(() => request({ type: 'GET_CURRENT_CAPTURE_STATUS' }), status => status?.connection === 'connected'); report.checks.push('old_open_page_connected');
  if (!regression) {
    for (const mode of ['click-only', 'rollback', 'dialog']) {
      await page.goto(`${url}?case=${mode}`); await delay(150); await page.locator('button[aria-label="收藏"]').click(); await delay(1300);
      assert.equal((await request({ type: 'GET_STATE' })).favorites.length, 0, `${mode} must not capture`);
      report.checks.push(`${mode}_does_not_capture`);
    }
    await page.goto(url); await delay(150);
  }
  await page.locator('button[aria-label="收藏"]').click();
  if (regression) {
    await delay(1400); assert.equal((await request({ type: 'GET_STATE' })).favorites.length, 0);
    report.checks.push('0.2.4_direct_success_without_dialog_or_toast_missed');
  } else {
    await delay(350); assert.equal((await request({ type: 'GET_STATE' })).favorites.length, 0); report.checks.push('waits_for_stable_explicit_state');
    const state = await poll(() => request({ type: 'GET_STATE' }), state => state.favorites.length === 1); const item = state.favorites[0];
    assert.equal(item.reviewUrl, url); assert.equal(item.source, 'zhihu'); assert.equal(item.title, '固定知乎一键收藏测试');
    for (const field of ['description', 'summary']) assert.equal(item[field], undefined);
    report.checks.push('trusted_direct_toggle_saved_without_dialog_or_toast');
    const status = await request({ type: 'GET_CURRENT_CAPTURE_STATUS' }); assert.equal(status.page.code, 'saved'); report.checks.push('saved_status_confirmed');
    await request({ type: 'UPDATE_FAVORITE', id: item.id, patch: { status: 'completed', note: '保持复盘进度' } });
    await page.reload(); await delay(150); await page.locator('button[aria-label="收藏"]').click(); await delay(1300);
    const repeated = await request({ type: 'GET_STATE' }); assert.equal(repeated.favorites.length, 1);
    assert.equal(repeated.favorites[0].status, 'completed'); assert.equal(repeated.favorites[0].reviewAt, item.reviewAt); assert.equal(repeated.favorites[0].note, '保持复盘进度');
    report.checks.push('duplicate_preserves_review_state_and_note');
  }
  report.status = 'PASSED';
} catch (error) { report.status = 'FAILED'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (context) await context.close();
  if (run) { const root = await realpath(profileRoot); const target = await realpath(run); assert.equal(path.dirname(target), root); assert.match(path.basename(target), /^run-[a-zA-Z0-9]+$/); assert.equal((await lstat(run)).isSymbolicLink(), false); await rm(target, { recursive: true, force: true, maxRetries: 3 }); }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(repo, 'docs', regression ? 'ZHIHU_0_2_4_DIRECT_REGRESSION.json' : 'ZHIHU_DIRECT_BROWSER_RESULT.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
