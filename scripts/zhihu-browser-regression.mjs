import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir, mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Permission-granted fixture only: production JS is copied verbatim. The test
// manifest grants its existing optional origins to exercise the post-grant path.
// All HTTP(S) requests are fulfilled locally; no real site or account is accessed.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(repo, '.browser-test-profile');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repo, '.cache-browser');
const regression = process.argv.includes('--expect-regression');
const wakeRegression = process.argv.includes('--expect-wake-regression');
const runtimeReload = process.argv.includes('--test-runtime-reload');
const report = { kind: 'permission-granted-fixed-HTML', productionManifestTested: false, optionalPermissionPromptTested: false, liveSiteTested: false, notVerified: ['真实登录知乎及实际授权弹窗', '用户Chrome中重载扩展后恢复；独立命令行扩展重载探针遇ERR_BLOCKED_BY_CLIENT，另记失败证据'], checks: [], startedAt: new Date().toISOString() };
let context; let run;
const invalidationWarnings = [];
const answer = 'https://www.zhihu.com/question/2073083082199011507/answer/2096980414967694847';
async function poll(read, accept) { for (let i = 0; i < 50; i++) { const value = await read(); if (accept(value)) return value; await delay(100); } throw new Error('固定页面等待扩展状态超时'); }
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>独立回答固定测试标题</title></head><body><div class="AnswerItem"><meta itemprop="url" content="${answer}"><div class="ContentItem-actions"><button class="ContentItem-action">收藏</button></div></div><script>
document.querySelector('.ContentItem-action').onclick=()=>{
const modal=document.createElement('div');modal.className='Modal-content';modal.innerHTML='<div class="Favlists-content"><div class="Favlists-items" role="list"><div class="Favlists-item"><button class="Favlists-updateButton">收藏</button></div></div><button class="Modal-closeButton">关闭</button></div>';document.body.append(modal);
modal.querySelector('.Modal-closeButton').onclick=()=>modal.remove();
modal.querySelector('.Favlists-updateButton').onclick=e=>{document.querySelector('.ContentItem-action').textContent='已收藏';e.target.textContent='已收藏';};
};</script></body></html>`;
try {
  await mkdir(testRoot, { recursive: true }); run = await mkdtemp(path.join(testRoot, 'run-'));
  const extension = path.join(run, 'extension'); await cp(path.join(repo, '.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = path.join(extension, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  report.version = manifest.version;
  manifest.host_permissions.push(...manifest.optional_host_permissions); delete manifest.optional_host_permissions;
  await writeFile(manifestFile, JSON.stringify(manifest));
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(path.join(run, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  report.chromiumVersion = context.browser()?.version();
  await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(); await page.goto(answer);
  page.on('console', message => { if (/Extension context invalidated/i.test(message.text())) invalidationWarnings.push(message.text()); });
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  const request = async message => { const response = await popup.evaluate(value => chrome.runtime.sendMessage(value), message); assert.equal(response?.ok, true, response?.error); return response.data; };
  await request({ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: true } });
  await poll(() => worker.evaluate(async tabUrl => {
    const [tab] = await chrome.tabs.query({ url: tabUrl });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => typeof window.__bookmindZhihuDispose === 'function' });
    return result.result;
  }, answer), value => value === true);
  // executeScript is never used to synthesize a click. Playwright input is trusted.
  await delay(400);
  await page.bringToFront(); await page.locator('.ContentItem-action').click(); await page.locator('.Modal-closeButton').click();
  await delay(150); assert.equal((await request({ type: 'GET_STATE' })).favorites.length, 0); report.checks.push('cancel_does_not_capture');
  await page.locator('.ContentItem-action').click();
  if (!regression) {
    await popup.evaluate(async tabUrl => {
      const [tab] = await chrome.tabs.query({ url: tabUrl });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => { window.__bookmindRegressionDispose = window.__bookmindZhihuDispose; } });
    }, answer);
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach(); report.checks.push('isolated_service_worker_stopped_during_candidate');
  }
  await page.locator('.Favlists-updateButton').click();
  if (regression) {
    await delay(500); assert.equal((await request({ type: 'GET_STATE' })).favorites.length, 0); report.checks.push('0.2.2_text_only_toolbar_regression_reproduced');
  } else if (wakeRegression) {
    await delay(700); await request({ type: 'GET_STATE' });
    const replaced = await popup.evaluate(async tabUrl => {
      const [tab] = await chrome.tabs.query({ url: tabUrl });
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => window.__bookmindRegressionDispose !== window.__bookmindZhihuDispose }); return result.result;
    }, answer);
    assert.equal(replaced, true); report.checks.push('0.2.3_worker_wake_replaced_live_listener_reproduced');
  } else {
    const state = await poll(() => request({ type: 'GET_STATE' }), value => value.favorites.length === 1);
    assert.equal(state.favorites[0].reviewUrl, answer); assert.equal(state.favorites[0].source, 'zhihu');
    assert.equal(state.favorites[0].title, '独立回答固定测试标题');
    for (const field of ['description', 'summary']) assert.equal(state.favorites[0][field], undefined);
    report.checks.push('old_open_detail_injected_and_text_only_success_saved');
    const preserved = await popup.evaluate(async tabUrl => {
      const [tab] = await chrome.tabs.query({ url: tabUrl });
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => window.__bookmindRegressionDispose === window.__bookmindZhihuDispose }); return result.result;
    }, answer);
    assert.equal(preserved, true); report.checks.push('worker_wake_preserves_live_listener_and_saves');
    const status = await request({ type: 'GET_CURRENT_CAPTURE_STATUS' });
    assert.equal(status.connection, 'connected'); assert.equal(status.page.code, 'saved'); report.checks.push('popup_status_connected_and_saved');
    await popup.reload();
    await popup.locator('[aria-label="当前页监听状态"]').waitFor();
    assert.match(await popup.locator('[aria-label="当前页监听状态"]').innerText(), /记录已保存/);
    report.checks.push('popup_ui_renders_actual_saved_status');
    const direct = await popup.evaluate(async tabUrl => { const [tab] = await chrome.tabs.query({ url: tabUrl }); return chrome.tabs.sendMessage(tab.id, { type: 'BOOKMIND_ZHIHU_STATUS' }, { frameId: 0 }); }, answer);
    assert.equal(direct.page.code, 'saved'); report.checks.push('content_status_after_real_message_and_storage');
    await page.reload(); await delay(300); await page.locator('.ContentItem-action').click(); await page.locator('.Favlists-updateButton').click(); await delay(300);
    assert.equal((await request({ type: 'GET_STATE' })).favorites.length, 1); report.checks.push('future_navigation_dynamic_script_and_deduplication');
    if (runtimeReload) {
    const resumedWorker = context.waitForEvent('serviceworker', { predicate: candidate => candidate.url().startsWith(`chrome-extension://${id}/`), timeout: 10_000 }).then(value => ({ value }), error => ({ error }));
    await popup.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
    // A reloaded MV3 worker can stay dormant until an extension page needs it.
    await delay(300);
    const reloadedPopup = await context.newPage(); await reloadedPopup.goto(`chrome-extension://${id}/popup.html`);
    const resumed = await resumedWorker;
    if (resumed.error) throw resumed.error;
    await page.bringToFront();
    const recovered = await poll(() => reloadedPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CURRENT_CAPTURE_STATUS' })), response => response?.ok && response.data?.connection === 'connected');
    assert.equal(recovered.data.version, manifest.version);
    const retained = await reloadedPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    assert.equal(retained.data.favorites.length, 1);
    assert.deepEqual(invalidationWarnings, []);
    report.checks.push('runtime_reload_reconnects_existing_page_without_context_error_spam');
    report.checks.push('runtime_reload_retains_saved_records');
    }
  }
  report.status = 'PASSED';
} catch (error) { report.status = 'FAILED'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (context) await context.close();
  if (run) {
    const root = await realpath(testRoot); const target = await realpath(run);
    assert.equal(path.dirname(target), root); assert.match(path.basename(target), /^run-[a-zA-Z0-9]+$/);
    assert.equal((await lstat(run)).isSymbolicLink(), false); await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(repo, 'docs', regression ? 'ZHIHU_0_2_2_REGRESSION.json' : wakeRegression ? 'ZHIHU_0_2_3_WAKE_REGRESSION.json' : runtimeReload ? 'ZHIHU_RUNTIME_RELOAD_RESULT.json' : 'ZHIHU_BROWSER_RESULT.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
