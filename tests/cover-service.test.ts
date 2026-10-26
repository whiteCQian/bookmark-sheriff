// @vitest-environment-options {"url":"https://www.bilibili.com/video/BV1xx411c7mD/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPageCover } from '../src/cover/read-cover';
import { CoverService } from '../src/services/cover.service';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService } from '../src/services/storage.service';
import type { AppState } from '../src/models/favorite';

describe('仅封面的自包含读取函数（DOM fixture）', () => {
  beforeEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });

  it('序列化注入后只返回当前 URL 和安全封面，不读取页面文字或结构化内容', () => {
    document.head.innerHTML = '<title>不应提取标题</title><meta property="og:image" content="//images.example.com/cover.jpg"><meta name="description" content="不要保存"><script type="application/ld+json">{"image":"https://example.com/wrong.jpg"}</script>';
    document.body.innerHTML = '<h1>不应提取正文</h1><p>不要保存的文章</p><img src="https://example.com/recommendation.jpg">';
    const isolated = new Function(`return (${readPageCover.toString()})`)() as typeof readPageCover;
    expect(isolated()).toEqual({ url: location.href, coverUrl: 'https://images.example.com/cover.jpg' });
  });

  it('没有明确封面字段时不扫描普通图片、正文或 JSON-LD', () => {
    document.head.innerHTML = '<script type="application/ld+json">{"image":"https://example.com/wrong.jpg"}</script>';
    document.body.innerHTML = '<p>文章</p><img src="https://example.com/recommendation.jpg">';
    expect(readPageCover()).toEqual({ url: location.href });
  });

  it('占位图或非法 og:image 可以降级为 twitter:image，支持相对 URL', () => {
    document.head.innerHTML = '<meta property="og:image" content="https://i0.hdslb.com/transparent.png@672w.webp"><meta name="twitter:image" content="/cover.jpg">';
    expect(readPageCover().coverUrl).toBe('https://www.bilibili.com/cover.jpg');
  });

  it.each([' ', 'javascript:alert(1)', 'data:image/png;base64,AA==', 'blob:https://example.com/id', 'file:///cover.jpg', 'https://user:password@example.com/cover.jpg'])('拒绝不安全图片值 %s', value => {
    const meta = document.createElement('meta'); meta.setAttribute('property', 'og:image'); meta.content = value; document.head.append(meta);
    expect(readPageCover().coverUrl).toBeUndefined();
  });

  it('只接受主播放器明确 poster，不把其他视频或推荐图片当封面', () => {
    document.body.innerHTML = '<video poster="https://example.com/other-video.jpg"></video><img src="https://example.com/recommended.jpg"><div class="bpx-player-container"><video poster="https://example.com/current-video.jpg"></video></div>';
    expect(readPageCover().coverUrl).toBe('https://example.com/current-video.jpg');
  });

  it('B站明确的 poster 元素支持图片和 CSS 背景，不读取其他背景图', () => {
    document.body.innerHTML = '<div style="background-image:url(https://example.com/wrong.jpg)"></div><div class="bpx-player-video-poster" style="background-image:url(https://example.com/poster.jpg)"></div>';
    expect(readPageCover().coverUrl).toBe('https://example.com/poster.jpg');
    document.body.innerHTML = '<div class="bpx-player-video-poster"><img src="//example.com/primary.jpg"></div>';
    expect(readPageCover().coverUrl).toBe('https://example.com/primary.jpg');
  });
});

describe('授权封面补充与收藏隔离', () => {
  let state: AppState | undefined;
  let favorites: FavoriteService;
  let covers: CoverService;
  const executeScript = vi.fn();
  const getTab = vi.fn();
  const queryTabs = vi.fn();
  const page = 'https://example.com/read';
  const image = 'https://images.example.com/cover.jpg';
  beforeEach(() => {
    state = undefined;
    favorites = new FavoriteService(new StorageService({ read: async () => state, write: async value => { state = structuredClone(value); } }), () => 1000);
    covers = new CoverService(favorites);
    executeScript.mockReset().mockResolvedValue([{ result: { url: page, coverUrl: image } }]);
    getTab.mockReset().mockResolvedValue({ id: 7, url: page });
    queryTabs.mockReset().mockResolvedValue([{ id: 7 }]);
    vi.stubGlobal('chrome', { scripting: { executeScript }, tabs: { get: getTab, query: queryTabs } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const capture = () => favorites.capture('chrome', { title: '书签事件标题', originalUrl: page, reviewUrl: page, contentType: 'unknown' });

  it('封面补充只修改 coverUrl，保留用户标题、备注、完成状态和提醒代次', async () => {
    const record = await capture();
    await favorites.update(record.id, { title: '用户编辑标题', note: '我的备注', status: 'completed' });
    await favorites.storage.transaction(value => { value.favorites[0].notifiedAt = 900; });
    const before = (await favorites.storage.snapshot()).favorites[0];
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'updated', recordId: record.id });
    expect((await favorites.storage.snapshot()).favorites[0]).toEqual({ ...before, coverUrl: image });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7, frameIds: [0] }, func: readPageCover });
    await favorites.capture('chrome', { ...record, coverUrl: 'https://example.com/duplicate.jpg' });
    expect((await favorites.storage.snapshot()).favorites[0]).toEqual({ ...before, coverUrl: image });
  });

  it('无当前页 URL 授权时不注入，基础收藏和提醒完整保留', async () => {
    const record = await capture(); const before = await favorites.storage.snapshot();
    getTab.mockResolvedValue({ id: 7 });
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    expect(executeScript).not.toHaveBeenCalled();
    expect(await favorites.storage.snapshot()).toEqual(before);
  });

  it('页面在读取前导航，或已有跨页 pendingUrl，均不注入', async () => {
    const record = await capture();
    for (const tab of [{ id: 7, url: 'https://example.com/other' }, { id: 7, url: page, pendingUrl: 'https://example.com/other' }]) {
      getTab.mockResolvedValue(tab);
      expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    }
    expect(executeScript).not.toHaveBeenCalled();
    expect((await favorites.storage.snapshot()).favorites[0].coverUrl).toBeUndefined();
  });

  it('读取期间导航或脚本返回其他页面，均不会把封面写入旧收藏', async () => {
    const record = await capture();
    getTab.mockResolvedValueOnce({ id: 7, url: page }).mockResolvedValueOnce({ id: 7, url: 'https://example.com/other' });
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    getTab.mockResolvedValue({ id: 7, url: page });
    executeScript.mockResolvedValue([{ result: { url: 'https://example.com/other', coverUrl: image } }]);
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    expect((await favorites.storage.snapshot()).favorites[0].coverUrl).toBeUndefined();
  });

  it('B站跨分集导航被拒绝，跟踪参数变化仍识别同一内容', async () => {
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
    const record = await favorites.capture('bilibili', { title: '第二集', originalUrl: url, reviewUrl: url, contentType: 'video' });
    getTab.mockResolvedValue({ id: 7, url: url.replace('p=2', 'p=3') });
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    getTab.mockResolvedValue({ id: 7, url: `${url}&spm_id_from=test#player` });
    executeScript.mockResolvedValue([{ result: { url, coverUrl: image } }]);
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'updated', recordId: record.id });
  });

  it('点击 Popup 只补充已收藏当前页，不会创建收藏', async () => {
    expect(await covers.refreshCurrentSavedPage()).toEqual({ status: 'no_saved_record' });
    expect(executeScript).not.toHaveBeenCalled();
    expect((await favorites.storage.snapshot()).favorites).toEqual([]);
    const record = await capture();
    expect(await covers.refreshCurrentSavedPage()).toEqual({ status: 'updated', recordId: record.id });
    expect((await favorites.storage.snapshot()).favorites).toHaveLength(1);
  });

  it('读取失败、受限页面或标签丢弃都静默降级，不修改基础记录或写诊断', async () => {
    const record = await capture(); const before = await favorites.storage.snapshot();
    executeScript.mockRejectedValue(new Error('no permission: private page'));
    expect(await covers.updateActiveSaved(record.id)).toEqual({ status: 'unavailable' });
    for (const tab of [{ id: 7, url: 'chrome://settings' }, { id: 7, url: page, discarded: true }]) {
      getTab.mockResolvedValue(tab);
      expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    }
    expect(await favorites.storage.snapshot()).toEqual(before);
  });

  it('缺失或危险封面不会清掉已有封面，格式损坏的脚本结果同样降级', async () => {
    const record = await favorites.capture('chrome', { title: '旧收藏', originalUrl: page, reviewUrl: page, contentType: 'unknown', coverUrl: image });
    for (const result of [undefined, null, {}, { url: page }, { url: page, coverUrl: 'data:image/png;base64,AA==' }, { url: page, coverUrl: 'https://user:secret@example.com/image.jpg' }]) {
      executeScript.mockResolvedValue([{ result }]);
      expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
      expect((await favorites.storage.snapshot()).favorites[0].coverUrl).toBe(image);
    }
  });

  it('读取时删除的记录不会被封面写入复活', async () => {
    const record = await capture();
    executeScript.mockImplementation(async () => { await favorites.remove(record.id); return [{ result: { url: page, coverUrl: image } }]; });
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'no_saved_record' });
    expect((await favorites.storage.snapshot()).favorites).toEqual([]);
  });

  it('写入失败不改报基础收藏失败，错误恢复后仍可补充封面', async () => {
    const record = await capture(); const before = await favorites.storage.snapshot();
    const setter = vi.spyOn(favorites, 'setCover').mockRejectedValueOnce(new Error('quota'));
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'unavailable' });
    expect(await favorites.storage.snapshot()).toEqual(before);
    expect(await covers.updateSaved(7, record.id)).toEqual({ status: 'updated', recordId: record.id });
    setter.mockRestore();
  });

  it('无活动标签、查询失败及旧 recordId 均不会注入或新增记录', async () => {
    queryTabs.mockResolvedValue([]); expect(await covers.updateActiveSaved('missing')).toEqual({ status: 'unavailable' });
    expect(await covers.refreshCurrentSavedPage()).toEqual({ status: 'unavailable' });
    queryTabs.mockRejectedValue(new Error('closed')); expect(await covers.refreshCurrentSavedPage()).toEqual({ status: 'unavailable' });
    expect(await covers.updateSaved(7, 'missing')).toEqual({ status: 'no_saved_record' });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
