import { describe, expect, it } from 'vitest';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService } from '../src/services/storage.service';
import { DAY_MS, type AppState } from '../src/models/favorite';
import { bilibiliIdentity, contentKey } from '../src/utils/url';

function setup() {
  let data: AppState | undefined;
  const storage = new StorageService({ read: async () => data, write: async value => { data = structuredClone(value); } });
  return { storage, service: new FavoriteService(storage, () => 1000) };
}
const content = { title: '文章', originalUrl: 'https://example.com/read?utm_source=x', reviewUrl: 'https://example.com/read?utm_source=x', contentType: 'unknown' as const };
describe('本地收藏和去重', () => {
  it('自动保存并使用默认三天提醒', async () => {
    const { service, storage } = setup();
    await service.capture('chrome', content);
    expect((await storage.snapshot()).favorites[0]).toMatchObject({ title: '文章', reviewAt: 1000 + 3 * DAY_MS, status: 'pending' });
  });
  it('新记录只增加安全封面白名单，仍不接受旧描述、摘要或任意注入值', async () => {
    const { service, storage } = setup();
    const supplied = { ...content, description: '旧简介', coverUrl: 'https://example.com/cover.jpg', summary: '旧摘要', note: '注入备注', status: 'completed', titleEdited: true, notifiedAt: 5, arbitrary: '不要保存' };
    await service.capture('chrome', supplied);
    expect((await storage.snapshot()).favorites[0]).toEqual({
      title: content.title, originalUrl: content.originalUrl, reviewUrl: content.reviewUrl,
      contentType: 'unknown', id: expect.any(String), source: 'chrome',
      coverUrl: 'https://example.com/cover.jpg',
      contentKey: 'https://example.com/read', createdAt: 1000,
      reviewAt: 1000 + 3 * DAY_MS, status: 'pending',
    });
  });
  it.each(['javascript:alert(1)', 'data:image/png;base64,AA==', 'blob:https://example.com/id', 'https://user:secret@example.com/cover.jpg', 'file:///cover.png'])('非法封面 %s 不影响基础收藏保存', async coverUrl => {
    const { service, storage } = setup();
    await service.capture('chrome', { ...content, coverUrl });
    expect((await storage.snapshot()).favorites[0].coverUrl).toBeUndefined();
    expect((await storage.snapshot()).favorites[0]).toMatchObject({ title: content.title, status: 'pending', reviewAt: 1000 + 3 * DAY_MS });
  });
  it('优先保存合法的书签创建时间，提醒从该时间计算', async () => {
    const { service } = setup();
    expect(await service.capture('chrome', content, 500)).toMatchObject({ createdAt: 500, reviewAt: 500 + 3 * DAY_MS });
  });
  it.each([undefined, NaN, Infinity, -1, 1001, 8_640_000_000_000_001])('非法或未来书签时间 %s 回退当前时间', async capturedAt => {
    const { service } = setup();
    expect(await service.capture('chrome', content, capturedAt)).toMatchObject({ createdAt: 1000, reviewAt: 1000 + 3 * DAY_MS });
  });
  it('并发来源去重且不重置已完成任务', async () => {
    const { service, storage } = setup();
    const [first] = await Promise.all(Array.from({ length: 20 }, () => service.capture('chrome', content)));
    await service.update(first.id, { status: 'completed' });
    await service.capture('bilibili', { ...content, reviewUrl: 'https://example.com/read#section' });
    expect((await storage.snapshot()).favorites).toHaveLength(1);
    expect((await storage.snapshot()).favorites[0].status).toBe('completed');
  });
  it('修改默认间隔仅影响新增记录', async () => {
    const { service, storage } = setup();
    await service.capture('chrome', content);
    await service.settings({ defaultReviewDays: 7 });
    await service.capture('chrome', { ...content, reviewUrl: 'https://example.com/next' });
    expect((await storage.snapshot()).favorites.map(item => item.reviewAt)).toEqual([1000 + 7 * DAY_MS, 1000 + 3 * DAY_MS]);
  });
  it('拒绝危险链接和非法时间，失败后队列可继续工作', async () => {
    const { service } = setup();
    await expect(service.capture('chrome', { ...content, reviewUrl: 'javascript:alert(1)' })).rejects.toThrow();
    const record = await service.capture('chrome', content);
    await expect(service.update(record.id, { reviewAt: NaN })).rejects.toThrow();
    await service.update(record.id, { reviewAt: 2000 });
  });
  it('B站去跟踪参数且保留分集，不合并不同视频或集数', () => {
    expect(contentKey('https://www.bilibili.com/video/BV1ex411x7Em/?p=2&spm_id_from=a')).toBe('bilibili:BV1ex411x7Em:p2');
    expect(contentKey('https://www.bilibili.com/video/BV1ex411x7Em/')).not.toBe(contentKey('https://www.bilibili.com/video/BV1ex411x7Em/?p=2'));
  });
  it('B站复盘链接保留合法 t 定位秒数，去重仍按 BV 与分集', () => {
    const url = 'https://www.bilibili.com/video/BV1ex411x7Em/?p=2&t=95.5&spm_id_from=tracking';
    expect(bilibiliIdentity(url)?.reviewUrl).toBe('https://www.bilibili.com/video/BV1ex411x7Em/?p=2&t=95.5');
    expect(contentKey(url)).toBe('bilibili:BV1ex411x7Em:p2');
    expect(contentKey(url)).toBe(contentKey(url.replace('95.5', '0')));
  });
  it.each(['-1', 'NaN', 'Infinity', '1e3', 'javascript:alert(1)', '9007199254740992'])('B站忽略非法 t 定位值 %s', position => {
    expect(bilibiliIdentity(`https://www.bilibili.com/video/BV1ex411x7Em/?t=${encodeURIComponent(position)}`)?.reviewUrl).toBe('https://www.bilibili.com/video/BV1ex411x7Em/');
  });
  it('损坏的数据不会被覆盖', async () => {
    let writes = 0;
    const storage = new StorageService({ read: async () => ({ schemaVersion: 99 }), write: async () => { writes++; } });
    await expect(storage.transaction(() => undefined)).rejects.toThrow('未覆盖');
    expect(writes).toBe(0);
  });
});
