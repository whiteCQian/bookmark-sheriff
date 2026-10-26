import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FavoriteRecord } from '../src/models/favorite';
import { FavoriteService } from '../src/services/favorite.service';
import { createMessageRouter } from '../src/services/message-router';
import { StorageService } from '../src/services/storage.service';
import { zhihuIdentity } from '../src/utils/url';

const article = 'https://zhuanlan.zhihu.com/p/28852607';
const answer = 'https://www.zhihu.com/question/123/answer/456';
const extension = { id: 'test', url: 'chrome-extension://test/options.html' };
const sender = (url = article, overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: 'test', url, frameId: 0, tab: { id: 42 } as chrome.tabs.Tab, ...overrides });
let granted: boolean;
function setup() {
  let data: unknown;
  const storage = new StorageService({ read: async () => data, write: async value => { data = structuredClone(value); } });
  const favorites = new FavoriteService(storage, () => 1000);
  const changed = vi.fn(async () => {});
  const capture = vi.fn(async () => {});
  const route = createMessageRouter(favorites, changed, vi.fn(async () => {}), { capture, clear: async () => {} });
  return { storage, favorites, changed, capture, route };
}
beforeEach(() => {
  granted = true;
  vi.stubGlobal('chrome', { runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}` }, permissions: { contains: vi.fn(async () => granted) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('知乎消息鉴权与最小持久化', () => {
  it.each([article, answer])('获授权并开启后保存当前详情 %s，重复不重置复盘进度', async url => {
    const { route, favorites, storage, capture, changed } = setup();
    await favorites.settings({ zhihuEnabled: true });
    const request = { type: 'ZHIHU_FAVORITE', url: `${url}?utm_source=test`, title: '当前页面标题', description: '不要保存', coverUrl: 'https://example.com/cover.jpg', note: '不要注入' };
    const record = await route(request, sender(url)) as FavoriteRecord;
    expect(record).toMatchObject({ source: 'zhihu', title: '当前页面标题', originalUrl: request.url, reviewUrl: url, contentType: 'unknown', createdAt: 1000, status: 'pending' });
    expect(record).not.toHaveProperty('description'); expect(record).not.toHaveProperty('coverUrl'); expect(record).not.toHaveProperty('note');
    await favorites.update(record.id, { status: 'completed', note: '个人备注' });
    await route(request, sender(url));
    expect((await storage.snapshot()).favorites).toHaveLength(1);
    expect((await storage.snapshot()).favorites[0]).toMatchObject({ status: 'completed', note: '个人备注', reviewAt: record.reviewAt });
    expect(capture).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledTimes(2);
  });
  it('只返回本站的采集布尔值，不向知乎内容脚本暴露管理数据或其他设置', async () => {
    const { route, favorites } = setup();
    expect(await route({ type: 'GET_CAPTURE_SETTINGS' }, sender())).toEqual({ zhihuEnabled: false });
    await favorites.settings({ zhihuEnabled: true });
    expect(await route({ type: 'GET_CAPTURE_SETTINGS' }, sender())).toEqual({ zhihuEnabled: true });
    granted = false;
    expect(await route({ type: 'GET_CAPTURE_SETTINGS' }, sender())).toEqual({ zhihuEnabled: false });
    await expect(route({ type: 'GET_STATE' }, sender())).rejects.toThrow('仅扩展管理页面');
  });
  it.each([false, true])('设置为 %s 而未满足完整启用条件时不保存', async enabled => {
    const { route, favorites, storage, changed, capture } = setup();
    await favorites.settings({ zhihuEnabled: enabled }); granted = !enabled;
    await route({ type: 'ZHIHU_FAVORITE', url: article, title: '标题' }, sender());
    expect((await storage.snapshot()).favorites).toEqual([]); expect(changed).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });
  it.each([
    sender('http://zhuanlan.zhihu.com/p/28852607'), sender('https://zhuanlan.zhihu.com.evil.example/p/28852607'),
    sender('https://www.zhihu.com/'), sender('https://www.zhihu.com/question/123'),
    sender('https://zhuanlan.zhihu.com/p/28852607', { frameId: 1 }), sender(article, { frameId: undefined }), sender(article, { tab: undefined }),
    sender('https://zhuanlan.zhihu.com:444/p/28852607'), extension,
  ])('非法来源无副作用 %#', async source => {
    const { route, storage, changed } = setup();
    await expect(route({ type: 'ZHIHU_FAVORITE', url: article, title: '标题' }, source)).rejects.toThrow('收藏事件来源无效');
    expect((await storage.snapshot()).favorites).toEqual([]); expect(changed).not.toHaveBeenCalled();
  });
  it.each([answer, article.replace('28852607', '28852608'), 'javascript:alert(1)', null])('拒绝跨文章、跨类型或无效链接 %s', async url => {
    const { route } = setup();
    await expect(route({ type: 'ZHIHU_FAVORITE', url, title: '标题' }, sender())).rejects.toThrow('知乎页面已切换');
  });
  it('同一回答ID但不同问题ID不能通过页面归属校验', async () => {
    const { route } = setup();
    await expect(route({ type: 'ZHIHU_FAVORITE', url: answer.replace('/123/', '/124/'), title: '标题' }, sender(answer))).rejects.toThrow('知乎页面已切换');
  });
  it('后台拒绝在无站点权限时开启，但允许关闭', async () => {
    const { route, storage } = setup(); granted = false;
    await expect(route({ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: true } }, extension)).rejects.toThrow('请先允许知乎站点访问');
    expect((await storage.snapshot()).settings.zhihuEnabled).toBe(false);
    await route({ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: false } }, extension);
  });
  it('Chrome书签与知乎原生收藏按同一文章去重，保留已有备注和提醒', async () => {
    const { route, favorites, storage } = setup();
    const saved = await favorites.capture('chrome', { title: '书签标题', originalUrl: `${article}/?share_code=old`, reviewUrl: `${article}/?share_code=old`, contentType: 'unknown' });
    await favorites.update(saved.id, { status: 'ignored', note: '旧备注' });
    await favorites.settings({ zhihuEnabled: true });
    const result = await route({ type: 'ZHIHU_FAVORITE', url: article, title: '页面标题' }, sender()) as FavoriteRecord;
    expect(result).toMatchObject({ id: saved.id, title: '书签标题', source: 'chrome', status: 'ignored', note: '旧备注', reviewAt: saved.reviewAt, reviewUrl: saved.reviewUrl });
    expect((await storage.snapshot()).favorites).toHaveLength(1);
  });
  it('详情身份只使用HTTPS精确域名和数字ID，移除入口跟踪参数', () => {
    expect(zhihuIdentity(`${article}/?utm_source=test#section`)).toEqual({ kind: 'article', id: '28852607', reviewUrl: article });
    expect(zhihuIdentity(answer)).toEqual({ kind: 'answer', id: '456', questionId: '123', reviewUrl: answer });
    expect(zhihuIdentity('https://www.zhihu.com/question/123/answer/456/comments')).toBeUndefined();
  });
});
