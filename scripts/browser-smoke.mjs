import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, '.output', 'chrome-mv3');
const profileRoot = path.join(root, '.browser-test-profile');
const screenshotsPath = path.join(root, 'docs', 'screenshots');
const resultPath = path.join(root, 'docs', 'BROWSER_SMOKE_RESULT.json');
const storageKey = 'bookmind.state.v1';
const captureFeedbackKey = 'bookmind.capture-feedback';
const captureNotificationId = 'bookmind:capture-feedback';
const bookmarkUrl = 'https://example.com/bookmind-smoke?utm_source=test';
const canonicalKey = 'https://example.com/bookmind-smoke';
const reminderAlarm = 'bookmind.next-review';
const baselineSettings = { defaultReviewDays: 3, notificationsEnabled: true, bilibiliEnabled: true, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' };
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache-browser');

const report = {
  status: 'RUNNING',
  startedAt: new Date().toISOString(),
  extensionPath,
  testProfileRoot: profileRoot,
  testProfile: null,
  resultFile: resultPath,
  chromiumVersion: null,
  checks: [],
  pageErrors: [],
  notVerified: [
    '用户安装的 Chrome 浏览器开发者模式加载；本次使用独立测试 profile 的 Chromium 命令行加载。',
    '扩展在真实登录 B站及知乎上的原生收藏、取消、失败反馈和 SPA 操作；实际网站观察另记研究报告。',
    '操作系统是否实际显示通知，以及真实通知正文和按钮点击。',
    '浏览器彻底关闭后重启恢复、电脑休眠和系统时钟改变。',
    '真实外部网站：测试入口由 Playwright 在浏览器内提供固定 HTML；封面验证只覆盖授权页固定样例，不代表所有网站均可读取封面。正文、描述、摘要等内容解析仍已移除。',
    '截图只提供视觉 QA 产物，本脚本不判断视觉质量。',
  ],
};
let context;
let profilePath;
let contextClosed = false;
let popup;
let worker;
let extensionId;
const createdBookmarkIds = [];

function output(event) {
  console.log(JSON.stringify(event));
}

async function check(name, action) {
  try {
    const detail = await action();
    const result = { name, status: detail?.outcome === 'SKIPPED' ? 'SKIPPED' : 'PASSED', ...(detail === undefined ? {} : { detail }) };
    report.checks.push(result);
    output({ event: 'check', ...result });
    return detail;
  } catch (error) {
    const result = { name, status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    report.checks.push(result);
    output({ event: 'check', ...result });
    throw error;
  }
}

async function poll(description, read, accept, timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await delay(intervalMs);
  }
  throw new Error(`${description} 超时（${timeoutMs}ms）；最后结果：${JSON.stringify(last)}`);
}

async function request(message) {
  const result = await popup.evaluate(value => chrome.runtime.sendMessage(value), message);
  assert.equal(result?.ok, true, `${message.type} 失败：${result?.error ?? JSON.stringify(result)}`);
  return result.data;
}

async function storedState() {
  return popup.evaluate(async key => (await chrome.storage.local.get(key))[key], storageKey);
}

async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}

try {
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3, '待测试的产物必须为 Manifest V3');
  const popupFile = manifest.action?.default_popup ?? 'popup.html';
  await access(path.join(extensionPath, popupFile));
  const { chromium } = await import('playwright');

  await check('extension_launch_and_worker', async () => {
    // A new leaf per run prevents the unchanged extension version from reusing an old worker.
    // Keep prior test-profile contents intact; only this newly created run leaf is disposable.
    await mkdir(profileRoot, { recursive: true });
    profilePath = await mkdtemp(path.join(profileRoot, 'run-'));
    report.testProfile = profilePath;
    output({ event: 'fresh_test_profile', profileRoot, profilePath });
    try {
      context = await chromium.launchPersistentContext(profilePath, {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1440, height: 1000 },
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      });
    } catch (error) {
      throw new Error(`Chromium 启动失败；使用项目专用 profile ${profilePath} 和浏览器目录 ${process.env.PLAYWRIGHT_BROWSERS_PATH}。${error instanceof Error ? error.message : String(error)}`);
    }
    report.chromiumVersion = context.browser()?.version() ?? '版本 API 不可用';
    const observePage = page => page.on('pageerror', error => report.pageErrors.push({ url: page.url(), message: error.message }));
    context.on('page', observePage);
    for (const page of context.pages()) observePage(page);
    await context.route('https://example.com/bookmind-smoke*', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>不应替换书签标题</title><meta name="description" content="不应采集的描述"><meta property="og:image" content="https://images.example.test/no-permission-cover.png"></head><body><h1>测试标题</h1><p>此固定页面只用于验证扩展打开原始链接。</p></body></html>',
    }));
    // Local image fixtures avoid an external network dependency while still
    // exercising the browser's real lazy image loading and referrer policy.
    await context.route('https://images.example.test/**', route => route.fulfill({
      status: 200, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#507662"/></svg>',
    }));
    worker = context.serviceWorkers().find(candidate => candidate.url().startsWith('chrome-extension://'))
      ?? await context.waitForEvent('serviceworker', { predicate: candidate => candidate.url().startsWith('chrome-extension://'), timeout: 15_000 });
    extensionId = new URL(worker.url()).hostname;
    const installed = await worker.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() }));
    assert.equal(installed.id, extensionId);
    assert.equal(installed.manifest.manifest_version, 3);
    assert.equal(installed.manifest.name, manifest.name);
    assert.equal(installed.manifest.version, manifest.version);
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${popupFile}`, { waitUntil: 'load' });
    await request({ type: 'GET_STATE' });
    // Passive observation uses genuine extension API events; it does not call the scheduler.
    await popup.evaluate(() => {
      globalThis.__bookmindSmokeAlarms = [];
      chrome.alarms.onAlarm.addListener(alarm => globalThis.__bookmindSmokeAlarms.push({ name: alarm.name, scheduledTime: alarm.scheduledTime, observedAt: Date.now() }));
    });
    return { extensionId, workerUrl: worker.url(), manifestVersion: installed.manifest.manifest_version, version: installed.manifest.version, chromiumVersion: report.chromiumVersion, freshProfile: profilePath };
  });

  await check('isolated_test_setup', async () => {
    // This profile is a project test fixture, never the user's default browser profile.
    await request({ type: 'CLEAR_DATA' });
    await request({ type: 'UPDATE_SETTINGS', patch: baselineSettings });
    // Empty no-op transactions need not initialize storage in a fresh profile.
    const state = await request({ type: 'GET_STATE' });
    assert.equal(state.favorites.length, 0);
    assert.deepEqual(state.settings, baselineSettings);
    return { profile: profilePath, favoriteCount: state.favorites.length };
  });

  const record = await check('real_bookmark_onCreated_capture', async () => {
    const bookmark = await worker.evaluate(url => chrome.bookmarks.create({ title: '冒烟测试文章', url }), bookmarkUrl);
    createdBookmarkIds.push(bookmark.id);
    const state = await poll('真实书签 onCreated 写入 storage.local', storedState,
      value => value?.favorites?.some(item => item.contentKey === canonicalKey));
    const captured = state.favorites.find(item => item.contentKey === canonicalKey);
    assert.equal(state.favorites.length, 1);
    assert.equal(captured.source, 'chrome');
    assert.equal(captured.title, '冒烟测试文章');
    assert.equal(captured.originalUrl, bookmarkUrl);
    assert.equal(captured.status, 'pending');
    assert.equal(captured.reviewAt, captured.createdAt + 3 * 86_400_000);
    return captured;
  });

  await check('minimal_capture_and_opt_in_permissions', async () => {
    const snapshot = await request({ type: 'GET_STATE' });
    const item = snapshot.favorites.find(item => item.id === record.id);
    for (const field of ['description', 'coverUrl', 'summary']) assert.equal(item[field], undefined);
    assert.equal(item.title, '冒烟测试文章');
    const removed = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'REFRESH_CURRENT_METADATA' }));
    assert.equal(removed.ok, false, '已删除的解析消息不得继续执行');
    const permission = await popup.evaluate(() => chrome.permissions.contains({ origins: ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*'] }));
    assert.equal(permission, false, '全新配置默认不得获得知乎访问权限');
    const scripts = await popup.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.equal(scripts.some(script => script.id === 'bookmind-zhihu'), false);
    const xPermission = await popup.evaluate(() => chrome.permissions.contains({ origins: ['https://x.com/*'] }));
    assert.equal(xPermission, false);
    assert.equal(scripts.some(script => script.id === 'bookmind-x'), false);
    return { minimalFieldsWithoutPagePermission: true, metadataMessageRejected: true, zhihuPermissionGranted: false, zhihuScriptRegistered: false, xPermissionGranted: false, xScriptRegistered: false };
  });

  await check('real_capture_confirmation', async () => {
    const receipt = await poll('保存成功后的会话回执',
      () => popup.evaluate(async key => (await chrome.storage.session.get(key))[key], captureFeedbackKey),
      value => value?.kind === 'saved' && value.recordId === record.id);
    assert.equal(receipt.title, '已记入 BookMind Next');
    assert(receipt.detail.includes('复盘时间'));
    const notifications = await popup.evaluate(() => chrome.notifications.getAll());
    assert.equal(Object.hasOwn(notifications, captureNotificationId), false, '无页内授权时只保留Popup回执，不发系统通知');
    const panel = popup.locator('[aria-label="最近收藏结果"]');
    await panel.waitFor();
    assert((await panel.textContent()).includes(receipt.title), 'Popup 应保留最近保存结果');
    await mkdir(screenshotsPath, { recursive: true });
    await popup.screenshot({ path: path.join(screenshotsPath, 'capture-confirmation-popup.png'), fullPage: true });
    return { savedReceiptAfterCommit: true, popupReceiptVisible: true, notificationApiCreated: false, systemNotificationSuppressed: true };
  });

  await check('real_duplicate_bookmark_deduplication', async () => {
    const bookmark = await worker.evaluate(url => chrome.bookmarks.create({ title: '重复冒烟收藏', url }), bookmarkUrl);
    createdBookmarkIds.push(bookmark.id);
    // Allow the real asynchronous onCreated pipeline to settle, then sample repeatedly.
    await delay(500);
    for (let sample = 0; sample < 5; sample++) {
      const state = await storedState();
      assert.equal(state.favorites.length, 1, '重复 Chrome 书签不应产生第二条收藏');
      assert.equal(state.favorites[0].id, record.id);
      assert.equal(state.favorites[0].reviewAt, record.reviewAt);
      await delay(200);
    }
    const receipt = await popup.evaluate(async key => (await chrome.storage.session.get(key))[key], captureFeedbackKey);
    assert.equal(receipt.kind, 'duplicate');
    assert.equal(receipt.recordId, record.id);
    return { bookmarkEventsCreated: createdBookmarkIds.length, favoriteCount: 1, recordId: record.id, duplicateFeedbackConfirmed: true };
  });

  await check('real_hash_route_bookmark_identity', async () => {
    const routeUrls = [
      `${canonicalKey}#/article/1`,
      `${canonicalKey}#/article/2`,
      `${canonicalKey}#!/article/3`,
    ];
    const routeIds = [];
    try {
      for (const [index, url] of routeUrls.entries()) {
        const bookmark = await worker.evaluate(value => chrome.bookmarks.create(value), { title: `哈希路由测试 ${index + 1}`, url });
        createdBookmarkIds.push(bookmark.id);
      }
      const captured = await poll('真实书签保留各个哈希路由的内容身份', storedState,
        state => routeUrls.every(url => state?.favorites?.some(item => item.contentKey === url)));
      assert.equal(captured.favorites.length, 4, '不同哈希路由不应互相合并，也不应与普通页面合并');
      for (const url of routeUrls) {
        const item = captured.favorites.find(candidate => candidate.contentKey === url);
        assert.equal(item.originalUrl, url);
        assert.equal(item.reviewUrl, url);
        routeIds.push(item.id);
      }
      const duplicate = await worker.evaluate(url => chrome.bookmarks.create({ title: '哈希路由追踪参数重复', url }), `${canonicalKey}?utm_source=route#/article/1`);
      createdBookmarkIds.push(duplicate.id);
      await delay(500);
      for (let sample = 0; sample < 3; sample++) {
        const state = await storedState();
        assert.equal(state.favorites.length, 4, '同一哈希路由仅追踪参数不同，应保持一条收藏');
        assert.equal(state.favorites.find(item => item.contentKey === routeUrls[0])?.id, routeIds[0]);
        await delay(200);
      }
      return { distinctRouteKeys: routeUrls, routeRecordCount: routeIds.length, trackingDuplicateMerged: true };
    } finally {
      // Keep later existing management/alarm checks scoped to the original real bookmark.
      const state = await storedState();
      for (const item of state.favorites.filter(candidate => candidate.id !== record.id)) {
        await request({ type: 'DELETE_FAVORITE', id: item.id });
      }
    }
  });

  await check('real_authorized_page_capture_toast', async () => {
    // Fixed HTML under the existing host permission verifies injection only;
    // it is not a real signed-in Bilibili favorite or live-site validation.
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>BookMind 页内提示测试</title><h1>固定测试页面，不访问真实 B站收藏</h1>' }));
    const page = await context.newPage();
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD/?bookmind_capture_test=1';
    let capturedId;
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.bringToFront();
      const bookmark = await worker.evaluate(url => chrome.bookmarks.create({ title: '页内确认测试', url }), url);
      createdBookmarkIds.push(bookmark.id);
      const state = await poll('授权页面真实书签事件保存', storedState,
        value => value?.favorites?.some(item => item.contentKey === 'bilibili:BV1xx411c7mD:p1'));
      capturedId = state.favorites.find(item => item.contentKey === 'bilibili:BV1xx411c7mD:p1').id;
      const toast = page.locator('#bookmind-next-capture-feedback');
      await toast.waitFor();
      const toastPanel = toast.getByRole('status');
      assert((await toastPanel.innerText()).includes('已记入 BookMind Next'));
      assert((await toastPanel.innerText()).includes('复盘时间'));
      await page.screenshot({ path: path.join(screenshotsPath, 'capture-confirmation-page.png'), fullPage: true });
      await toast.getByRole('button', { name: '关闭 BookMind 提示' }).click();
      await toast.waitFor({ state: 'detached' });
      return { actualScriptingInjection: true, shadowDomToastVisible: true, closeButtonWorks: true, liveBilibiliSiteVerified: false };
    } finally {
      if (capturedId) await request({ type: 'DELETE_FAVORITE', id: capturedId });
      await page.close();
    }
  });

  await check('real_authorized_cover_only_refresh', async () => {
    const firstCover = 'https://images.example.test/first-cover.png';
    const refreshedCover = 'https://images.example.test/refreshed-cover.png';
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD/?bookmind_cover_test=1';
    await context.route('**/*bookmind_cover_test=1', route => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>页面标题不能覆盖书签标题</title><meta property="og:image" content="${firstCover}"><meta name="description" content="禁止保存的正文描述"><script type="application/ld+json">{"description":"禁止读取的结构化内容"}</script></head><body><article>禁止保存的正文内容</article></body></html>`,
    }));
    const page = await context.newPage();
    let capturedId;
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.bringToFront();
      const bookmark = await worker.evaluate(url => chrome.bookmarks.create({ title: '仅封面测试书签', url }), url);
      createdBookmarkIds.push(bookmark.id);
      const state = await poll('已授权当前页在基础保存后补充封面', storedState,
        state => state?.favorites?.some(item => item.contentKey === 'bilibili:BV1xx411c7mD:p1' && item.coverUrl === firstCover));
      const captured = state.favorites.find(item => item.contentKey === 'bilibili:BV1xx411c7mD:p1');
      capturedId = captured.id;
      assert.equal(captured.title, '仅封面测试书签');
      assert.equal(captured.description, undefined);
      assert.equal(captured.summary, undefined);
      await request({ type: 'UPDATE_FAVORITE', id: capturedId, patch: { status: 'completed', note: '封面补充必须保留个人备注' } });
      await page.evaluate(cover => {
        document.title = '再次变化的页面标题';
        document.querySelector('meta[property="og:image"]').setAttribute('content', cover);
      }, refreshedCover);
      await page.bringToFront();
      const result = await request({ type: 'REFRESH_CURRENT_COVER' });
      assert.equal(result.status, 'updated');
      assert.equal(result.recordId, capturedId);
      const after = await storedState();
      const updated = after.favorites.find(item => item.id === capturedId);
      assert.equal(updated.coverUrl, refreshedCover);
      assert.equal(updated.title, captured.title);
      assert.equal(updated.reviewAt, captured.reviewAt);
      assert.equal(updated.createdAt, captured.createdAt);
      assert.equal(updated.status, 'completed');
      assert.equal(updated.note, '封面补充必须保留个人备注');
      assert.equal(updated.description, undefined);
      assert.equal(updated.summary, undefined);
      assert.equal(after.favorites.length, state.favorites.length);
      await page.goto('https://www.bilibili.com/video/BV1ex411x7Em/?bookmind_cover_test=1', { waitUntil: 'load' });
      await page.bringToFront();
      const unsaved = await request({ type: 'REFRESH_CURRENT_COVER' });
      assert.equal(unsaved.status, 'no_saved_record');
      assert.equal((await storedState()).favorites.length, after.favorites.length, '封面刷新不得新建收藏');
      return { actualAuthorizedCoverInjection: true, automaticCoverAfterCapture: true, refreshOnlyChangedCover: true, titleAndReviewStatePreserved: true, noDescriptionOrSummarySaved: true, unsavedPageDidNotCapture: true, fixedFixtureOnly: true, liveSiteVerified: false };
    } finally {
      await page.close();
      if (capturedId) await request({ type: 'DELETE_FAVORITE', id: capturedId });
    }
  });

  await check('real_bilibili_detector_with_fixed_fixture', async () => {
    const url = 'https://www.bilibili.com/video/BV1ex411x7Em/?p=2&t=25.5&bookmind_fixture=1';
    await context.route('**/*bookmind_fixture=1', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><meta charset="utf-8"><title>固定收藏检测样例</title><button class="video-fav" title="收藏（E）">收藏</button><script>
        document.querySelector('.video-fav').onclick=()=>{
          const modal=document.createElement('div');modal.className='collection-m-exp';modal.innerHTML='添加到收藏夹<label id="fixture-folder"><input hidden type="checkbox">默认收藏夹</label><button class="btn submit-move" id="fixture-confirm" disabled>确定</button><button class="close" id="fixture-cancel">取消</button>';document.body.append(modal);
          modal.querySelector('input').onchange=e=>modal.querySelector('#fixture-confirm').disabled=!e.target.checked;
          modal.querySelector('#fixture-cancel').onclick=()=>modal.remove();
          modal.querySelector('#fixture-confirm').onclick=()=>{document.querySelector('.video-fav').classList.add('on');modal.remove();};
        };</script>` }));
    const page = await context.newPage();
    let capturedId;
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.locator('.video-fav').click();
      await page.locator('#fixture-cancel').click();
      await delay(200);
      assert.equal((await storedState()).favorites.some(item => item.contentKey === 'bilibili:BV1ex411x7Em:p2'), false);
      await page.locator('.video-fav').click();
      await page.locator('#fixture-folder').click();
      await page.locator('#fixture-confirm').click();
      const state = await poll('真实Content Script收到可信点击与成功态后入库', storedState,
        state => state.favorites.some(item => item.contentKey === 'bilibili:BV1ex411x7Em:p2'));
      const item = state.favorites.find(item => item.contentKey === 'bilibili:BV1ex411x7Em:p2');
      capturedId = item.id;
      assert.equal(item.source, 'bilibili');
      assert.equal(new URL(item.reviewUrl).searchParams.get('p'), '2');
      assert.equal(new URL(item.reviewUrl).searchParams.get('t'), '25.5');
      for (const field of ['description', 'coverUrl', 'summary']) assert.equal(item[field], undefined);
      return { actualContentScriptAndTrustedClicks: true, cancelDidNotCapture: true, nativeCollectionDialogWithoutToastCaptured: true, confirmedSuccessCaptured: true, minimalFieldsOnly: true, episodeAndTimeRetained: true, liveBilibiliSiteVerified: false };
    } finally {
      await page.close();
      if (capturedId) await request({ type: 'DELETE_FAVORITE', id: capturedId });
    }
  });

  await check('legacy_identity_repair_and_invalid_record_quarantine', async () => {
    const before = await storedState();
    const legacyUrl = `${canonicalKey}#/legacy/article/2`;
    const legacy = { ...record, id: 'smoke-legacy-route', title: '兼容修复健康记录', originalUrl: legacyUrl, reviewUrl: legacyUrl, contentKey: canonicalKey, description: '历史描述保留但不显示', coverUrl: 'https://images.example.test/legacy.png', summary: '历史摘要保留但不显示' };
    const invalid = { id: 'smoke-invalid-record', title: 17, originalUrl: 'javascript:alert(1)', status: 'broken', reviewAt: 'bad-date', rawMarker: 'preserve-this-invalid-test-value' };
    const fixture = { ...before, favorites: [legacy, invalid], settings: { ...baselineSettings, notificationsEnabled: false } };
    try {
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: storageKey, value: fixture });
      const snapshot = await request({ type: 'GET_STATE' });
      assert.equal(snapshot.favorites.length, 1, '一条异常记录不应使健康记录无法读取');
      assert.equal(snapshot.favorites[0].id, legacy.id);
      assert.equal(snapshot.favorites[0].contentKey, legacyUrl, '历史去重键应在读取视图中按原始哈希路由修复');
      assert.deepEqual(await storedState(), fixture, 'GET_STATE 的兼容修复不应直接覆盖原始存储');
      await request({ type: 'UPDATE_FAVORITE', id: legacy.id, patch: { note: '健康记录仍可编辑，并持久化兼容修复' } });
      const persisted = await storedState();
      assert.equal(persisted.favorites.length, 1);
      assert.equal(persisted.favorites[0].contentKey, legacyUrl);
      assert.equal(persisted.favorites[0].note, '健康记录仍可编辑，并持久化兼容修复');
      assert.equal(persisted.favorites[0].description, legacy.description);
      assert.equal(persisted.favorites[0].coverUrl, legacy.coverUrl);
      assert.equal(persisted.favorites[0].summary, legacy.summary);
      const dashboard = await context.newPage();
      const imageRequests = [];
      const observe = req => { if (req.url().startsWith('https://images.example.test/')) imageRequests.push({ url: req.url(), referer: req.headers().referer }); };
      context.on('request', observe);
      try {
        await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`, { waitUntil: 'load' });
        await dashboard.getByRole('button', { name: '打开：兼容修复健康记录', exact: true }).waitFor();
        const image = dashboard.locator('.favorite-card img');
        await image.waitFor({ state: 'visible' });
        assert.equal(await image.count(), 1);
        assert.equal(await image.getAttribute('src'), legacy.coverUrl);
        assert.equal(await image.getAttribute('loading'), 'lazy');
        assert.equal(await image.getAttribute('referrerpolicy'), 'no-referrer');
        await poll('历史封面实际显示', () => image.evaluate(img => img.complete && img.naturalWidth > 0), Boolean);
        assert.equal((await dashboard.locator('body').textContent()).includes(legacy.description), false);
        assert.equal((await dashboard.locator('body').textContent()).includes(legacy.summary), false);
        assert(imageRequests.some(req => req.url === legacy.coverUrl), '应加载已有收藏封面');
        assert(imageRequests.every(req => req.referer === undefined), '封面请求不得发送 Referer');
      } finally { context.off('request', observe); await dashboard.close(); }
      const isolated = persisted.quarantine?.find(item => item.kind === 'favorite' && item.value?.id === invalid.id);
      assert(isolated, '正常修改后必须保留异常记录的隔离副本');
      assert.deepEqual(isolated.value, invalid, '隔离应保留异常记录原始值');
      assert.equal(typeof isolated.reason, 'string');
      assert(isolated.reason.length > 0);
      return { healthyRecordEditable: true, repairedKey: legacyUrl, readOnlySnapshotPreservedRawStorage: true, invalidRawValuePreserved: true, legacyCoverDisplayedWithoutReferer: true, legacyDescriptionAndSummaryNotRendered: true };
    } finally {
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: storageKey, value: before });
    }
  });

  await check('extension_page_management_messages', async () => {
    await request({ type: 'UPDATE_FAVORITE', id: record.id, patch: { title: '冒烟测试 · 已编辑', note: '真实 Chromium 消息与本地存储测试' } });
    const state = await request({ type: 'GET_STATE' });
    assert.equal(state.favorites[0].title, '冒烟测试 · 已编辑');
    assert.equal(state.favorites[0].note, '真实 Chromium 消息与本地存储测试');
    const beforeTabs = new Set(context.pages());
    await request({ type: 'OPEN_FAVORITE', id: record.id });
    const opened = await poll('OPEN_FAVORITE 创建真实内容标签页', async () => context.pages().find(page => !beforeTabs.has(page) && page.url() === record.reviewUrl), Boolean);
    await opened.waitForLoadState('domcontentloaded');
    const after = await storedState();
    assert.equal(after.favorites[0].status, 'pending', '打开内容必须保留待复盘状态');
    assert.equal(after.favorites[0].reviewAt, record.reviewAt);
    await opened.close();
    return { titleAndNoteSaved: true, openedUrl: record.reviewUrl, statusAfterOpening: after.favorites[0].status };
  });

  await check('settings_update_and_restore', async () => {
    const patch = { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false };
    await request({ type: 'UPDATE_SETTINGS', patch });
    assert.deepEqual((await storedState()).settings, { ...baselineSettings, ...patch });
    assert.equal((await storedState()).favorites[0].reviewAt, record.reviewAt, '默认间隔变化不应重设已有记录');
    await request({ type: 'UPDATE_SETTINGS', patch: baselineSettings });
    assert.deepEqual((await storedState()).settings, baselineSettings);
    return { updated: patch, restored: baselineSettings };
  });

  await check('real_alarm_notification_api', async () => {
    const reviewAt = Date.now() + 31_000;
    await request({ type: 'UPDATE_FAVORITE', id: record.id, patch: { reviewAt } });
    const scheduled = await popup.evaluate(() => chrome.alarms.getAll());
    assert(scheduled.some(alarm => alarm.name === reminderAlarm), '真实 next-review alarm 未创建');
    assert(scheduled.some(alarm => alarm.name === 'bookmind.reminder-watchdog'), '真实 watchdog alarm 未创建');
    output({ event: 'waiting_for_real_alarm', reviewAt, timeoutMs: 80_000, scheduledAlarms: scheduled });
    const delivered = await poll('真实 alarm 到期后通知 API 结果落盘', async () => {
      const state = await storedState();
      return state?.favorites?.find(item => item.id === record.id);
    }, item => typeof item?.notifiedAt === 'number' || typeof item?.notificationError === 'string', 80_000, 500);
    const observedAlarms = await poll('观察真实 next-review onAlarm 事件',
      () => popup.evaluate(() => globalThis.__bookmindSmokeAlarms),
      alarms => alarms.some(alarm => alarm.name === reminderAlarm), 3000, 100);
    if (typeof delivered.notificationError === 'string') {
      const detail = { reason: delivered.notificationError, observedAlarms, retryAt: delivered.notificationRetryAt };
      report.notVerified.push(`当前 headless Chromium 无法确认通知 API 投递：${delivered.notificationError}`);
      // The alarm fired, but an unavailable platform API is explicitly not a pass.
      return { outcome: 'SKIPPED', alarmFired: true, notificationApiDelivery: 'SKIPPED', ...detail };
    }
    assert(delivered.notifiedAt >= reviewAt, '通知成功标记早于计划时间');
    assert.equal(delivered.status, 'pending');
    const ids = await popup.evaluate(() => chrome.notifications.getAll());
    return { alarmFired: true, reviewAt, notifiedAt: delivered.notifiedAt, status: delivered.status, notificationIdsReportedByApi: Object.keys(ids), observedAlarms, osVisibilityAndClicksVerified: false };
  });

  await check('real_digest_notification_and_deduplication', async () => {
    const before = await storedState();
    const now = Date.now();
    const due = Array.from({ length: 8 }, (_, index) => ({ ...record,
      id: `smoke-digest-${index}`, title: `集中提醒测试 ${index + 1}`,
      originalUrl: `${canonicalKey}/digest/${index}`, reviewUrl: `${canonicalKey}/digest/${index}`,
      contentKey: `${canonicalKey}/digest/${index}`, reviewAt: now - 60_000 - index,
      notifiedAt: undefined, notificationClaimedAt: undefined, notificationRetryAt: undefined, notificationError: undefined,
    }));
    try {
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), {
        key: storageKey, value: { ...before, favorites: due, settings: { ...baselineSettings, reminderMode: 'digest' } },
      });
      await request({ type: 'UPDATE_SETTINGS', patch: { reminderMode: 'digest' } });
      const state = await poll('集中提醒为全部成员保存投递结果', storedState,
        state => state?.favorites?.every(item => typeof item.notifiedAt === 'number'));
      const notices = await popup.evaluate(() => chrome.notifications.getAll());
      const ids = Object.keys(notices).filter(id => id.startsWith('bookmind:digest:'));
      assert.equal(ids.length, 1, '多条同时到期应只有一条集中通知');
      assert.equal(state.favorites.length, 8);
      assert(state.favorites.every(item => item.status === 'pending'));
      const deliveredAt = state.favorites.map(item => item.notifiedAt);
      await request({ type: 'UPDATE_SETTINGS', patch: { reminderMode: 'single' } });
      await request({ type: 'UPDATE_SETTINGS', patch: { reminderMode: 'digest' } });
      assert.deepEqual((await storedState()).favorites.map(item => item.notifiedAt), deliveredAt);
      const after = await popup.evaluate(() => chrome.notifications.getAll());
      assert.equal(Object.keys(after).filter(id => id.startsWith('bookmind:review:')).length, 0);
      return { dueRecords: 8, digestNotifications: 1, modeSwitchDidNotRedeliver: true, allRemainPending: true, osVisibilityVerified: false };
    } finally {
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: storageKey, value: before });
      await request({ type: 'UPDATE_SETTINGS', patch: { reminderMode: 'single' } });
    }
  });

  await check('real_dashboard_batch_actions', async () => {
    const before = await storedState();
    const now = Date.now();
    const fixtures = Array.from({ length: 3 }, (_, index) => ({ ...record,
      id: `smoke-batch-${index}`, title: `批量处理测试 ${index + 1}`,
      originalUrl: `${canonicalKey}/batch/${index}`, reviewUrl: `${canonicalKey}/batch/${index}`,
      contentKey: `${canonicalKey}/batch/${index}`, reviewAt: now - 60_000 - index,
      notifiedAt: undefined, notificationClaimedAt: undefined, notificationRetryAt: undefined, notificationError: undefined,
    }));
    const dashboard = await context.newPage();
    try {
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), {
        key: storageKey, value: { ...before, favorites: fixtures, settings: { ...baselineSettings, notificationsEnabled: false } },
      });
      await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html?view=overdue`, { waitUntil: 'load' });
      await dashboard.getByRole('checkbox', { name: '选择：批量处理测试 1', exact: true }).check();
      await dashboard.getByRole('checkbox', { name: '选择：批量处理测试 2', exact: true }).check();
      await dashboard.getByLabel('批量延期', { exact: true }).selectOption('1');
      await poll('真实批量延期只改变两个所选计划', storedState, state => state.favorites.filter(item => item.reviewAt > now).length === 2);
      await poll('逾期视图只保留一条', () => dashboard.locator('.favorite-card').count(), count => count === 1);
      await dashboard.getByRole('checkbox', { name: '选择当前筛选的全部收藏', exact: true }).check();
      await dashboard.getByRole('button', { name: '批量完成', exact: true }).click();
      await poll('真实批量完成保存', storedState, state => state.favorites.filter(item => item.status === 'completed').length === 1);
      await dashboard.getByLabel('复盘状态筛选', { exact: true }).selectOption('all');
      await dashboard.getByRole('checkbox', { name: '选择当前筛选的全部收藏', exact: true }).check();
      await dashboard.getByRole('button', { name: '批量忽略', exact: true }).click();
      await poll('真实批量忽略保存', storedState, state => state.favorites.every(item => item.status === 'ignored'));
      return { postponeOnlySelected: true, completedOnlyRemainingOverdue: true, ignoreAllVisible: true, persisted: true };
    } finally {
      await dashboard.close();
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: storageKey, value: before });
    }
  });

  await check('extension_ui_screenshots', async () => {
    const pages = [
      { file: popupFile, name: 'popup', width: 390, height: 600 },
      { file: 'dashboard.html', name: 'dashboard', width: 1440, height: 1000 },
      { file: 'options.html', name: 'options', width: 1200, height: 1000 },
    ];
    const missing = [];
    for (const page of pages) if (!(await fileExists(path.join(extensionPath, page.file)))) missing.push(page.file);
    if (missing.length) {
      report.notVerified.push(`UI 三页面尚未全部构建，未截图：${missing.join(', ')}`);
      return { outcome: 'SKIPPED', screenshots: 'SKIPPED', missing };
    }
    await mkdir(screenshotsPath, { recursive: true });
    const saved = [];
    for (const target of pages) {
      const page = target.name === 'popup' ? popup : await context.newPage();
      await page.setViewportSize({ width: target.width, height: target.height });
      if (page !== popup) await page.goto(`chrome-extension://${extensionId}/${target.file}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
      await page.evaluate(() => document.fonts.ready);
      await delay(400);
      const screenshot = path.join(screenshotsPath, `${target.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      saved.push(screenshot);
      if (page !== popup) await page.close();
    }
    return { screenshots: saved, visualQualityVerified: false };
  });

  await check('real_popup_due_view_navigation', async () => {
    const before = await storedState();
    const current = before.favorites.find(item => item.id === record.id);
    assert(current, '到期视图检查需要前面的真实书签记录');
    const now = Date.now();
    const makeRecord = (id, title, reviewAt, status = 'pending') => ({
      ...current, id, title, originalUrl: `${canonicalKey}/${id}`, reviewUrl: `${canonicalKey}/${id}`,
      contentKey: `${canonicalKey}/${id}`, reviewAt, status, createdAt: now,
      notifiedAt: undefined, notificationClaimedAt: undefined, notificationRetryAt: undefined, notificationError: undefined,
    });
    const due = [
      makeRecord('smoke-due-3', '到期视图 · 较晚', now - 60_000),
      makeRecord('smoke-due-1', '到期视图 · 最早', now - 180_000),
      makeRecord('smoke-due-2', '到期视图 · 居中', now - 120_000),
      { ...current, reviewAt: now - 30_000 },
    ];
    const excluded = [
      makeRecord('smoke-future', '到期视图 · 未来不可见', now + 2 * 86_400_000),
      makeRecord('smoke-completed', '到期视图 · 已完成不可见', now - 240_000, 'completed'),
    ];
    let dashboard;
    try {
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), {
        key: storageKey,
        value: { ...before, favorites: [...due, ...excluded], settings: { ...baselineSettings, notificationsEnabled: false } },
      });
      await popup.reload({ waitUntil: 'load' });
      const more = popup.getByRole('link', { name: /查看其余 1 条/ });
      await more.waitFor();
      assert.equal(await more.getAttribute('href'), `chrome-extension://${extensionId}/dashboard.html?view=due`);
      const newPage = context.waitForEvent('page');
      await more.click();
      dashboard = await newPage;
      await dashboard.waitForURL(`chrome-extension://${extensionId}/dashboard.html?view=due`);
      await dashboard.getByLabel('复盘状态筛选', { exact: true }).waitFor();
      assert.equal(await dashboard.getByLabel('复盘状态筛选', { exact: true }).inputValue(), 'due');
      const titles = await poll('真实到期视图显示四条待复盘记录',
        () => dashboard.locator('.favorite-card h2').allTextContents(), values => values.length === due.length);
      const expected = [...due].sort((a, b) => a.reviewAt - b.reviewAt).map(item => item.title);
      assert.deepEqual(titles, expected, '到期视图应排除未来/已完成记录并按提醒时间升序');
      return { popupLinkOpenedDueView: true, selectedFilter: 'due', visibleRecordCount: titles.length, orderedTitles: titles, futureAndCompletedExcluded: true };
    } finally {
      if (dashboard) await dashboard.close();
      await popup.evaluate(async ({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: storageKey, value: before });
      await popup.reload({ waitUntil: 'load' });
    }
  });

  await check('real_dashboard_ui_interactions', async () => {
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`, { waitUntil: 'load' });
    await dashboard.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = dashboard.getByRole('dialog', { name: '编辑收藏' });
    await dialog.getByLabel(/个人备注/).fill('通过真实页面编辑保存，保留已到期的原提醒');
    await dialog.getByRole('button', { name: '保存更改', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await poll('真实编辑表单保存备注', storedState,
      state => state.favorites[0]?.note === '通过真实页面编辑保存，保留已到期的原提醒');
    await dashboard.getByRole('searchbox', { name: '搜索收藏' }).fill('不存在的测试关键词');
    await dashboard.getByRole('heading', { name: '暂时没有匹配的收藏' }).waitFor();
    await dashboard.getByRole('searchbox', { name: '搜索收藏' }).fill('');
    await dashboard.getByLabel('来源筛选', { exact: true }).selectOption('bilibili');
    await dashboard.getByRole('heading', { name: '暂时没有匹配的收藏' }).waitFor();
    await dashboard.getByLabel('来源筛选', { exact: true }).selectOption('all');
    await dashboard.getByLabel(/^延期提醒：/).selectOption('1');
    await poll('真实延期操作', storedState,
      state => state.favorites[0]?.reviewAt > Date.now() + 23 * 60 * 60 * 1000 && state.favorites[0]?.notifiedAt === undefined);
    await dashboard.getByRole('button', { name: '完成复盘', exact: true }).click();
    await poll('真实完成按钮', storedState, state => state.favorites[0]?.status === 'completed');
    await dashboard.setViewportSize({ width: 390, height: 844 });
    const size = await dashboard.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert(size.scroll <= size.width + 1, `窄页发生横向溢出：${JSON.stringify(size)}`);
    await dashboard.screenshot({ path: path.join(screenshotsPath, 'dashboard-narrow.png'), fullPage: true });
    await dashboard.getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = dashboard.getByRole('dialog', { name: '删除这条收藏？' });
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await storedState()).favorites.length, 1, '取消删除不得移除记录');
    await dashboard.getByRole('button', { name: '删除', exact: true }).click();
    await dashboard.getByRole('button', { name: '确认删除', exact: true }).click();
    await poll('真实删除确认', storedState, state => state.favorites.length === 0);
    await dashboard.close();
    return { editedPastReminderWithoutChangingTime: true, searchAndSourceFilter: true, postponedThenCompleted: true, narrowLayoutWidth: size.width, cancelledDeleteThenConfirmed: true };
  });

  await check('no_uncaught_page_errors', async () => {
    assert.deepEqual(report.pageErrors, []);
    return { pageErrorCount: report.pageErrors.length };
  });
  report.status = report.checks.some(item => item.status === 'SKIPPED') ? 'PASSED_WITH_SKIPS' : 'PASSED';
} catch (error) {
  report.status = 'FAILED';
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
  process.exitCode = 1;
} finally {
  if (context) {
    if (popup && !popup.isClosed() && createdBookmarkIds.length) {
      try {
        await popup.evaluate(async ids => {
          for (const id of ids) await chrome.bookmarks.remove(id);
        }, createdBookmarkIds);
      } catch (error) {
        report.cleanupWarning = `测试书签清理失败（仅影响专用测试 profile）：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    try { await context.close(); contextClosed = true; } catch (error) {
      report.status = 'FAILED';
      report.closeError = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  if (profilePath && contextClosed) {
    try {
      const resolvedRoot = await realpath(profileRoot);
      const resolvedProfile = await realpath(profilePath);
      const leaf = path.relative(resolvedRoot, resolvedProfile);
      assert(path.isAbsolute(resolvedRoot) && path.isAbsolute(resolvedProfile), '测试 profile 清理目标必须为绝对路径');
      assert.equal(path.dirname(resolvedProfile), resolvedRoot, '只允许清理测试 profile 根目录内本次创建的直接子目录');
      assert.match(leaf, /^run-[a-zA-Z0-9]+$/, '测试 profile 清理目标必须为 mkdtemp 创建的 run 目录');
      assert.equal(path.resolve(profilePath), resolvedProfile, '测试 profile 路径不得重定向到其他位置');
      assert.equal((await lstat(profilePath)).isSymbolicLink(), false, '不得递归清理符号链接 profile');
      await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      report.profileCleanup = { status: 'REMOVED', path: resolvedProfile, preservedRoot: resolvedRoot };
    } catch (error) {
      report.profileCleanup = { status: 'FAILED', path: profilePath, error: error instanceof Error ? error.message : String(error) };
      report.status = 'FAILED';
      process.exitCode = 1;
    }
  } else if (profilePath) {
    report.profileCleanup = { status: 'SKIPPED', path: profilePath, reason: '未确认 Chromium context 已关闭，保留本次独立目录以免影响仍在运行的进程。' };
  }
  report.finishedAt = new Date().toISOString();
  try {
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    report.status = 'FAILED';
    report.resultWriteError = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  output({ event: 'browser_smoke_report', ...report });
}
