import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type FavoriteRecord } from '../src/models/favorite';
import { contentKey, xPostIdentity } from '../src/utils/url';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService, emptyState } from '../src/services/storage.service';
import { createMessageRouter } from '../src/services/message-router';
import type { CaptureNotice } from '../src/models/capture';

const postId = '2097401882574591186';
const post = `https://x.com/alice/status/${postId}`;
const extension = { id: 'test', url: 'chrome-extension://test/options.html' };
const sender = (url = 'https://x.com/home', patch: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: 'test', url, frameId: 0, tab: { id: 42 } as chrome.tabs.Tab, ...patch });
let granted = true;
function setup(initial: unknown = emptyState()) {
  let data = structuredClone(initial);
  const storage = new StorageService({ read: async () => data, write: async value => { data = structuredClone(value); } });
  const favorites = new FavoriteService(storage, () => 1000);
  const changed = vi.fn(async () => {}); const capture = vi.fn(async () => {});
  const route = createMessageRouter(favorites, changed, async () => {}, { capture, clear: async () => {} });
  const request = { type: 'X_BOOKMARK', url: `${post}?s=20`, postId, preview: '这是当前帖子\n短预览', action: 'add' };
  return { storage, favorites, changed, capture, route, request };
}
beforeEach(() => { granted = true; vi.stubGlobal('chrome', { runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}` }, permissions: { contains: vi.fn(async () => granted) } }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('X 链接与字符串帖子ID', () => {
  it.each([post, `${post}/photo/1?s=20#view`, `${post}/video/2`, `https://x.com/i/status/${postId}`, `https://x.com/i/web/status/${postId}`])('归一化%s并按ID去重，不损失长整数精度', url => {
    expect(xPostIdentity(url)?.postId).toBe(postId); expect(contentKey(url)).toBe(`x:${postId}`);
    expect(xPostIdentity(url)?.reviewUrl).not.toMatch(/[?#]/);
  });
  it.each(['http://x.com/alice/status/123', 'https://x.com.evil.test/alice/status/123', 'https://twitter.com/alice/status/123', 'https://x.com:444/alice/status/123', 'https://x.com/alice/status/0', 'https://x.com/alice/status/12/comments', 'https://u:p@x.com/alice/status/123', 'https://x.com/home'])('拒绝非帖子或不安全链接%s', url => expect(xPostIdentity(url)).toBeUndefined());
});

describe('X 消息、持久化与旧数据兼容', () => {
  it('旧schema1设置缺X字段默认关闭，记录/备注/时间保留且读取不落盘', async () => {
    const old = emptyState(); delete (old.settings as Partial<typeof old.settings>).xEnabled;
    const { storage } = setup(old); const state = await storage.snapshot();
    expect(state.settings).toEqual(DEFAULT_SETTINGS); expect(state.quarantine).toBeUndefined();
  });
  it.each(['https://x.com/home', post, 'https://x.com/search?q=test'])('允许当前X文档%s中的不同帖子，入库预览、时间和原提醒', async url => {
    const { route, favorites, storage, request, capture, changed } = setup(); await favorites.settings({ xEnabled: true });
    const item = await route({ ...request, note: '不能注入', description: '不要采集' }, sender(url)) as FavoriteRecord & { captureNotice: CaptureNotice };
    expect(item).toMatchObject({ source: 'x', postId, textPreview: '这是当前帖子 短预览', title: '这是当前帖子 短预览', createdAt: 1000, reviewAt: 259201000, status: 'pending', contentKey: `x:${postId}`, reviewUrl: post });
    expect(item).not.toHaveProperty('note'); expect(item).not.toHaveProperty('description'); expect(capture).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ created: true }), 42, 'receipt');
    expect(item.captureNotice).toMatchObject({ kind: 'saved', recordId: item.id, title: '已记入 BookMind Next' });
    expect((await storage.snapshot()).favorites[0]).not.toHaveProperty('captureNotice');
  });
  it('没有文本的媒体帖仍记录帖子ID和链接，不提取视频/封面', async () => {
    const { route, favorites, request } = setup(); await favorites.settings({ xEnabled: true });
    const item = await route({ ...request, preview: '', coverUrl: 'https://example.com/video.jpg' }, sender()) as FavoriteRecord;
    expect(item.title).toBe(`X 帖子 ${postId}`); expect(item.textPreview).toBe(''); expect(item.coverUrl).toBeUndefined();
  });
  it('280个Unicode字符完整保留，超长或非字符串预览拒绝', async () => {
    const { route, favorites, request } = setup(); await favorites.settings({ xEnabled: true });
    const item = await route({ ...request, preview: '😀'.repeat(280) }, sender()) as FavoriteRecord;
    expect(Array.from(item.textPreview!)).toHaveLength(280); expect(Array.from(item.title)).toHaveLength(80);
    await expect(route({ ...request, preview: '😀'.repeat(281) }, sender())).rejects.toThrow('预览无效');
    await expect(route({ ...request, preview: {} }, sender())).rejects.toThrow('预览无效');
  });
  it('重复新增和已确认取消都保留既有复盘状态/备注/提醒，取消未知帖子不创建', async () => {
    const { route, favorites, storage, request } = setup(); await favorites.settings({ xEnabled: true });
    const item = await route(request, sender()) as FavoriteRecord; await favorites.update(item.id, { status: 'completed', note: '原备注' });
    const duplicate = await route({ ...request, url: `https://x.com/i/status/${postId}` }, sender()) as FavoriteRecord & { captureNotice: CaptureNotice };
    expect(duplicate.captureNotice).toMatchObject({ kind: 'duplicate', recordId: item.id, title: 'BookMind 中已有这条收藏' });
    const before = await storage.snapshot();
    expect(await route({ ...request, action: 'remove' }, sender())).toEqual({ action: 'remove', confirmed: true, postId });
    await route({ ...request, action: 'remove', url: 'https://x.com/bob/status/999', postId: '999' }, sender());
    expect((await storage.snapshot()).favorites).toEqual(before.favorites); expect(before.favorites).toHaveLength(1);
    expect(before.favorites[0]).toMatchObject({ status: 'completed', note: '原备注', reviewAt: item.reviewAt });
  });
  it('既有Chrome书签按帖子ID去重，仅补X字段，不改来源/用户标题/进度', async () => {
    const { route, favorites, storage, request } = setup();
    const old = await favorites.capture('chrome', { title: '自定书签', originalUrl: `https://x.com/i/status/${postId}`, reviewUrl: `https://x.com/i/status/${postId}`, contentType: 'unknown' });
    await favorites.update(old.id, { title: '编辑过的标题', status: 'ignored', note: '原备注' }); await favorites.settings({ xEnabled: true });
    const item = await route(request, sender()) as FavoriteRecord;
    expect(item).toMatchObject({ id: old.id, source: 'chrome', title: '编辑过的标题', status: 'ignored', note: '原备注', postId, textPreview: '这是当前帖子 短预览', reviewAt: old.reviewAt });
    expect((await storage.snapshot()).favorites).toHaveLength(1);
  });
  it('合法旧书签的原链接为跳转页时不补不兼容X字段，不隔离或丢失复盘任务', async () => {
    const { route, favorites, storage, request } = setup();
    const old = await favorites.capture('chrome', { title:'旧跳转书签', originalUrl:'https://example.com/redirect', reviewUrl:post, contentType:'unknown' });
    await favorites.update(old.id,{status:'completed',note:'必须保留'}); await favorites.settings({xEnabled:true});
    const result=await route(request,sender()) as FavoriteRecord;
    expect(result.id).toBe(old.id); expect(result.postId).toBeUndefined();
    const state=await storage.snapshot(); expect(state.favorites).toHaveLength(1); expect(state.quarantine).toBeUndefined();
    expect(state.favorites[0]).toMatchObject({id:old.id,status:'completed',note:'必须保留',reviewAt:old.reviewAt});
  });
  it.each([sender('https://evil.test/'),sender('http://x.com/home'),sender('https://x.com:444/home'),sender('https://x.com/home',{frameId:1}),sender('https://x.com/home',{id:'other'}),sender('https://x.com/home',{tab:undefined})])('拒绝非本扩展X顶层来源 %#', async origin => {
    const { route, request, storage } = setup(); await expect(route(request,origin)).rejects.toThrow('来源无效'); expect((await storage.snapshot()).favorites).toEqual([]);
  });
  it('消息不能伪造帖子ID、操作、其他站点URL或读取管理数据', async () => {
    const { route, request } = setup();
    for (const patch of [{ postId:'123' },{ action:'like' },{ url:'https://example.com/a' }]) await expect(route({...request,...patch},sender())).rejects.toThrow('无效');
    await expect(route({type:'GET_STATE'},sender())).rejects.toThrow('仅扩展管理页面');
  });
  it('未开启或权限撤销不入库，只读取本站开关，授权前不能开启', async () => {
    const { route, favorites, request, storage } = setup();
    expect(await route({type:'GET_CAPTURE_SETTINGS'},sender())).toEqual({xEnabled:false});
    expect(await route(request,sender())).toBeUndefined(); await favorites.settings({xEnabled:true}); granted=false;
    expect(await route(request,sender())).toBeUndefined(); expect(await route({type:'GET_CAPTURE_SETTINGS'},sender())).toEqual({xEnabled:false});
    await expect(route({type:'UPDATE_SETTINGS',patch:{xEnabled:true}},extension)).rejects.toThrow('请先允许 X');
    expect((await storage.snapshot()).favorites).toEqual([]);
  });
  it('X异常字段隔离但不影响健康旧记录', async () => {
    const { route, favorites, request, storage } = setup(); await favorites.settings({xEnabled:true}); const item=await route(request,sender()) as FavoriteRecord;
    const raw=await storage.snapshot(); raw.favorites.push({...item,id:'broken',postId:'999'});
    const repaired=await setup(raw).storage.snapshot(); expect(repaired.favorites).toHaveLength(1); expect(repaired.quarantine?.[0].reason).toContain('身份无效');
  });
});
