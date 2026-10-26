import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// The production JS is copied verbatim. Only this temporary manifest pregrants
// the already declared optional x.com origin; real permission prompts/live X
// are deliberately not represented by these fixed-HTML integration checks.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileRoot = path.join(repo, '.browser-test-profile');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repo, '.cache-browser');
const home = 'https://x.com/home';
const ids = ['1900000000000000001', '1900000000000000002', '1900000000000000003'];
const disabledId = '1900000000000000004';
const urls = [`https://x.com/alice/status/${ids[0]}`, `https://x.com/bob/status/${ids[1]}`, `https://x.com/carol/status/${ids[2]}`];
const preview = `首条帖子的预览🙂 ${'🌱'.repeat(300)}`;
const report = {
  kind: 'permission-granted-fixed-HTML-X', productionManifestTested: false,
  optionalPermissionPromptTested: false, liveSiteTested: false,
  notVerified: ['真实登录X的收藏/取消/失败反馈与DOM形态', '用户浏览器的可选权限弹窗及Chrome人工加载'],
  checks: [], pageErrors: [], startedAt: new Date().toISOString(),
};
let run; let context; let contextClosed = false;

async function poll(description, read, accept, timeout = 8000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(100); }
  throw new Error(`${description} 超时；最后结果：${JSON.stringify(last)}`);
}

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>X固定测试页面</title></head><body>
<main id="feed"></main><button id="more">Load fixture post</button><button id="disabled-post">Load disabled fixture post</button><button id="complete">Complete fixture operation</button>
<a id="spa-detail" href="/bob/status/${ids[1]}">Open fixture detail</a>
<script>
const posts=${JSON.stringify([{ id: ids[0], handle: 'alice', text: preview }, { id: ids[1], handle: 'bob', text: '第二条帖子' }, { id: ids[2], handle: 'carol', text: '' }, { id: disabledId, handle: 'dave', text: '关闭后不得收集' }])};
let pending;
function makePost(post) {
 const article=document.createElement('article');article.dataset.testid='tweet';article.dataset.fixtureId=post.id;
 const permalink=document.createElement('a');permalink.href='/'+post.handle+'/status/'+post.id;const time=document.createElement('time');time.dateTime='2026-10-25T00:00:00Z';time.textContent='now';permalink.append(time);article.append(permalink);
 if(post.text){const own=document.createElement('div');own.dataset.testid='tweetText';own.textContent=post.text;article.append(own);}
 else {const media=document.createElement('div');media.dataset.testid='tweetPhoto';media.setAttribute('aria-label','Image-only fixture');article.append(media);}
 const quote=document.createElement('article');quote.dataset.testid='tweet';quote.setAttribute('data-testid-quote','true');quote.innerHTML='<a href="/quoted/status/1900000000000000999"><time>quote</time></a><div data-testid="tweetText">不应进入预览的引用帖子</div>';article.append(quote);
 const unrelated=document.createElement('a');unrelated.href='/unrelated/status/1900000000000000888';unrelated.textContent='正文中的无关帖子地址';article.append(unrelated);
 const initiallySaved=new URL(location.href).searchParams.get('initial')==='saved';const button=document.createElement('button');button.dataset.testid=initiallySaved?'removeBookmark':'bookmark';button.setAttribute('aria-label',initiallySaved?'Remove bookmark':'Bookmark');button.setAttribute('aria-pressed',String(initiallySaved));button.textContent=initiallySaved?'Remove bookmark':'Bookmark';article.append(button);return article;
}
function toast(text) {document.querySelector('[data-testid="toast"]')?.remove();const node=document.createElement('div');node.dataset.testid='toast';node.setAttribute('role','status');node.textContent=text;document.body.append(node);}
function setState(article, saved) {const button=article.querySelector(':scope > button');button.dataset.testid=saved?'removeBookmark':'bookmark';button.setAttribute('aria-label',saved?'Remove bookmark':'Bookmark');button.setAttribute('aria-pressed',saved?'true':'false');button.textContent=saved?'Remove bookmark':'Bookmark';}
function finish(operation) {setState(operation.article,operation.add);toast(operation.add?'Added to your Bookmarks':'Removed from your Bookmarks');}
posts.slice(0,2).forEach(post=>document.querySelector('#feed').append(makePost(post)));
document.querySelector('#more').onclick=()=>{if(!document.querySelector('[data-fixture-id="'+posts[2].id+'"]'))document.querySelector('#feed').append(makePost(posts[2]));};
document.querySelector('#disabled-post').onclick=()=>document.querySelector('#feed').append(makePost(posts[3]));
document.querySelector('#complete').onclick=()=>{if(pending){finish(pending);pending=undefined;}};
document.querySelector('#spa-detail').onclick=e=>{e.preventDefault();history.pushState({},'',e.currentTarget.getAttribute('href'));};
document.addEventListener('click',e=>{const button=e.target.closest('button[data-testid="bookmark"],button[data-testid="removeBookmark"]');if(!button)return;
 const article=button.closest('article[data-testid="tweet"]');const operation={article,add:button.dataset.testid==='bookmark'};const mode=new URL(location.href).searchParams.get('mode');
 if(mode==='click-only')return;
 if(mode==='manual'){pending=operation;return;}
 if(mode==='failure'){setTimeout(()=>toast('Something went wrong. Try again.'),50);return;}
 if(mode==='unrelated'){setTimeout(()=>finish({article:document.querySelector('[data-fixture-id="'+posts[1].id+'"]'),add:true}),50);return;}
 if(mode==='state-only'){setTimeout(()=>setState(article,operation.add),50);return;}
 setTimeout(()=>finish(operation),50);
 if(mode==='rollback')setTimeout(()=>{setState(article,!operation.add);toast('Something went wrong. Try again.');},200);
 if(mode==='navigate')setTimeout(()=>history.pushState({},'','/settings/bookmarks'),100);
});
</script></body></html>`;

try {
  await mkdir(profileRoot, { recursive: true }); run = await mkdtemp(path.join(profileRoot, 'run-'));
  const extension = path.join(run, 'extension'); await cp(path.join(repo, '.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = path.join(extension, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert(manifest.optional_host_permissions?.includes('https://x.com/*'), 'Build must declare x.com as an optional origin first');
  report.version = manifest.version;
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'https://x.com/*'])];
  manifest.optional_host_permissions = manifest.optional_host_permissions.filter(origin => origin !== 'https://x.com/*');
  await writeFile(manifestFile, JSON.stringify(manifest));
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(path.join(run, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  report.chromiumVersion = context.browser()?.version();
  context.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
  await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage(); await page.goto(home);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const request = async message => { const response = await popup.evaluate(value => chrome.runtime.sendMessage(value), message); assert.equal(response?.ok, true, response?.error); return response.data; };
  const state = () => request({ type: 'GET_STATE' });
  const xRecords = async () => (await state()).favorites.filter(item => item.source === 'x');
  const contentStatus = () => popup.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' }); return chrome.tabs.sendMessage(tab.id, { type: 'BOOKMIND_X_STATUS' }, { frameId: 0 }); });
  const clickPost = id => page.locator(`article[data-fixture-id="${id}"] > button`).click();

  assert.equal((await state()).settings.xEnabled, false);
  const beforeScripts = await popup.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.equal(beforeScripts.some(script => script.id === 'bookmind-x'), false);
  report.checks.push('default_off_even_with_fixture_permission');
  await request({ type: 'UPDATE_SETTINGS', patch: { xEnabled: true } });
  await page.bringToFront();
  await poll('X旧标签页连接', contentStatus, value => value?.version === manifest.version && value.page);
  report.checks.push('opt_in_registers_and_injects_existing_timeline');

  for (const mode of ['click-only', 'state-only', 'failure', 'rollback', 'unrelated', 'navigate']) {
    await page.goto(`${home}?mode=${mode}`); await delay(200); await clickPost(ids[0]); await delay(1100);
    assert.equal((await xRecords()).length, 0, `${mode} must not record a bookmark`);
    report.checks.push(`${mode}_does_not_capture`);
  }

  await page.goto(`${home}?initial=saved`); await delay(200); await clickPost(ids[0]);
  await poll('未入库帖子取消收藏回执', contentStatus, value => value?.page?.code === 'removed');
  assert.equal((await xRecords()).length, 0); report.checks.push('confirmed_remove_without_local_record_does_not_create_task');

  await page.goto(`${home}?mode=manual`); await delay(200); const beforeCapture = Date.now(); await clickPost(ids[0]);
  await popup.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' }); await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => { window.__bookmindXFixtureDispose = window.__bookmindXDispose; } }); });
  const cdp = await context.newCDPSession(page); await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await cdp.detach();
  await page.locator('#complete').click();
  const records = await poll('X可信确认后入库', xRecords, value => value.length === 1); const first = records[0];
  assert.equal(first.postId, ids[0]); assert.equal(first.reviewUrl, urls[0]); assert.equal(first.originalUrl, urls[0]);
  assert.equal(first.textPreview, Array.from(preview).slice(0, 280).join(''));
  assert(!first.textPreview.includes('引用帖子')); assert(!first.textPreview.includes('无关帖子地址'));
  assert(first.createdAt >= beforeCapture && first.createdAt <= Date.now());
  assert.equal(first.reviewAt, first.createdAt + (await state()).settings.defaultReviewDays * 86_400_000);
  for (const field of ['description', 'summary']) assert.equal(first[field], undefined);
  report.checks.push('trusted_timeline_success_captures_id_preview_time_and_reminder');
  const captureToast = page.locator('#bookmind-next-capture-feedback');
  await captureToast.getByRole('status').waitFor();
  assert.match(await captureToast.getByRole('status').innerText(), /已记入 BookMind Next/);
  assert.match(await captureToast.getByRole('status').innerText(), /复盘时间/);
  assert.equal(page.url(), `${home}?mode=manual`);
  assert.equal((await popup.evaluate(() => chrome.notifications.getAll()))['bookmind:capture-feedback'], undefined);
  await captureToast.getByRole('button', { name: '关闭 BookMind 提示' }).click();
  await captureToast.waitFor({ state: 'detached' });
  report.checks.push('timeline_success_shows_shared_dismissible_page_toast_without_system_notification');
  const preserved = await popup.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' }); const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => window.__bookmindXFixtureDispose === window.__bookmindXDispose }); return result.result; });
  assert.equal(preserved, true); report.checks.push('worker_wake_preserves_live_detector');
  const activeStatus = await request({ type: 'GET_CURRENT_CAPTURE_STATUS' });
  assert.equal(activeStatus.site, 'x'); assert.equal(activeStatus.page.code, 'saved');
  await popup.reload(); await popup.locator('[aria-label="当前页监听状态"]').waitFor();
  const statusText = await popup.locator('[aria-label="当前页监听状态"]').innerText();
  assert.match(statusText, /X\s*监听状态/); assert.match(statusText, /记录已保存/);
  report.checks.push('active_page_status_and_popup_render_x_saved_state');

  await request({ type: 'UPDATE_FAVORITE', id: first.id, patch: { status: 'completed', note: 'X保留用户复盘进度' } });
  // The manual fixture still holds the saved state; remove is confirmed with its
  // own exact toast, but must not destroy the existing local review task.
  await clickPost(ids[0]); await page.locator('#complete').click(); await delay(1000);
  const afterRemove = await xRecords(); assert.equal(afterRemove.length, 1); assert.equal(afterRemove[0].id, first.id);
  assert.equal(afterRemove[0].status, 'completed'); assert.equal(afterRemove[0].note, 'X保留用户复盘进度');
  assert.equal((await contentStatus()).page.code, 'removed');
  report.checks.push('confirmed_remove_does_not_create_or_delete_local_task');
  await clickPost(ids[0]); await page.locator('#complete').click(); await delay(1000);
  const repeated = await xRecords(); assert.equal(repeated.length, 1); assert.equal(repeated[0].reviewAt, first.reviewAt); assert.equal(repeated[0].status, 'completed');
  report.checks.push('rebookmark_deduplicates_and_preserves_review_progress');
  await captureToast.getByRole('status').waitFor();
  assert.match(await captureToast.getByRole('status').innerText(), /BookMind 中已有这条收藏/);
  assert.match(await captureToast.getByRole('status').innerText(), /未重复添加/);
  assert.equal((await popup.evaluate(() => chrome.notifications.getAll()))['bookmind:capture-feedback'], undefined);
  report.checks.push('rebookmark_shows_duplicate_page_receipt_without_system_notification');

  await page.goto(home); await delay(200); await page.locator('#spa-detail').click();
  assert.equal(page.url(), urls[1]); await clickPost(ids[1]);
  const detailRecords = await poll('SPA详情收藏入库', xRecords, value => value.length === 2);
  assert(detailRecords.some(item => item.postId === ids[1] && item.reviewUrl === urls[1]));
  report.checks.push('spa_timeline_to_post_detail_captures_correct_post');
  await captureToast.getByRole('status').waitFor();
  assert.match(await captureToast.getByRole('status').innerText(), /已记入 BookMind Next/);
  assert.match(await captureToast.getByRole('status').innerText(), /第二条帖子/);
  assert.equal((await popup.evaluate(() => chrome.notifications.getAll()))['bookmind:capture-feedback'], undefined);
  report.checks.push('spa_post_detail_shows_page_toast_without_system_notification');
  await page.locator('#more').click(); await clickPost(ids[2]);
  const dynamicRecords = await poll('动态帖子入库', xRecords, value => value.length === 3);
  const mediaOnly = dynamicRecords.find(item => item.postId === ids[2]); assert(mediaOnly);
  assert(!mediaOnly.textPreview); assert(mediaOnly.title.includes(ids[2]));
  report.checks.push('dynamic_image_only_post_uses_id_without_quoted_preview');
  await poll('详情内其他帖子自己的网页回执', () => captureToast.getByRole('status').innerText(), text => text.includes(ids[2]));
  assert.equal((await popup.evaluate(() => chrome.notifications.getAll()))['bookmind:capture-feedback'], undefined);
  report.checks.push('different_post_in_detail_shows_own_page_receipt_without_system_notification');
  await page.locator('#disabled-post').click();
  await request({ type: 'UPDATE_SETTINGS', patch: { xEnabled: false } });
  await clickPost(disabledId); await delay(1100); assert.equal((await xRecords()).length, 3);
  report.checks.push('disable_stops_capture_in_existing_document');
  await page.goto(home); await delay(200); await clickPost(ids[0]); await delay(1100);
  assert.equal((await xRecords()).length, 3);
  const afterScripts = await popup.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.equal(afterScripts.some(script => script.id === 'bookmind-x'), false);
  report.checks.push('disable_unregisters_future_capture');
  assert.deepEqual(report.pageErrors, []); report.checks.push('no_uncaught_page_errors');
  report.status = 'PASSED';
} catch (error) { report.status = 'FAILED'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (context) { try { await context.close(); contextClosed = true; } catch (error) { report.status = 'FAILED'; report.closeError = String(error); process.exitCode = 1; } }
  if (run && contextClosed) {
    try {
      const root = await realpath(profileRoot); const target = await realpath(run);
      assert.equal(path.dirname(target), root); assert.match(path.basename(target), /^run-[a-zA-Z0-9]+$/);
      assert.equal(path.resolve(run), target); assert.equal((await lstat(run)).isSymbolicLink(), false);
      await rm(target, { recursive: true, force: true, maxRetries: 3 }); report.profileCleanup = 'REMOVED';
    } catch (error) { report.status = 'FAILED'; report.cleanupError = String(error); process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(repo, 'docs', 'X_BROWSER_RESULT.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
