import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, FavoriteRecord } from '../src/models/favorite';
import type { AppRequest } from '../src/models/messages';
import { STORAGE_KEY } from '../src/services/storage.service';
import { PopupApp } from '../src/ui/PopupApp';
import { DashboardApp } from '../src/ui/DashboardApp';
import { SettingsApp } from '../src/ui/SettingsApp';

// These are jsdom UI contract tests with mocked Chrome APIs, not real Chrome acceptance tests.
const now = new Date(2026, 9, 24, 12, 0).getTime();
const day = 86_400_000;
let container: HTMLDivElement;
let root: Root | undefined;
let state: AppState;
let failNext: string | undefined;
let listeners: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>;
let sendMessage: ReturnType<typeof vi.fn<(request: AppRequest) => Promise<unknown>>>;
let removeListener: ReturnType<typeof vi.fn>;
let getPermissionLevel: ReturnType<typeof vi.fn<() => Promise<'granted' | 'denied'>>>;

function record(id: string, patch: Partial<FavoriteRecord> = {}): FavoriteRecord {
  return {
    id, title: `收藏 ${id}`, source: 'chrome', contentType: 'article', contentKey: `page:${id}`,
    originalUrl: `https://example.com/${id}#saved`, reviewUrl: `https://example.com/${id}`,
    createdAt: now - day, reviewAt: now + day, status: 'pending', ...patch,
  };
}

describe('到期筛选与批量处理', () => {
  it('今日按本地日历、逾期按当前时刻筛选，均只显示pending并按提醒时间排序', async () => {
    state.favorites = [record('yesterday', { reviewAt: now - day }), record('morning', { reviewAt: now - 3600_000 }), record('evening', { reviewAt: now + 3600_000 }), record('tomorrow'), record('done', { status: 'completed', reviewAt: now - 1000 })];
    await mount(<DashboardApp />);
    await change(input('复盘状态筛选'), 'today');
    expect([...container.querySelectorAll('article h2')].map(element => element.textContent)).toEqual(['收藏 morning', '收藏 evening']);
    await change(input('复盘状态筛选'), 'overdue');
    expect([...container.querySelectorAll('article h2')].map(element => element.textContent)).toEqual(['收藏 yesterday', '收藏 morning']);
  });
  it('批量完成只发送所选ID一次，完成后清除选择', async () => {
    state.favorites = [record('one'), record('two'), record('three')];
    await mount(<DashboardApp />);
    expect(button('批量完成').disabled).toBe(true);
    await click(input('选择：收藏 one'));
    await click(input('选择：收藏 two'));
    await click(button('批量完成'));
    expect(requests('BATCH_UPDATE_FAVORITES')).toEqual([{ type: 'BATCH_UPDATE_FAVORITES', ids: ['one', 'two'], change: { kind: 'complete' } }]);
    expect(state.favorites.find(item => item.id === 'three')?.status).toBe('pending');
    expect(container.textContent).toContain('已选 0 条');
  });
  it('全选冻结当前可见记录；新收藏不自动加入，改筛选会清空选择', async () => {
    state.favorites = [record('one'), record('two')];
    await mount(<DashboardApp />);
    await click(input('选择当前筛选的全部收藏'));
    state.favorites.push(record('new'));
    await storageChange();
    expect((input('选择：收藏 new') as HTMLInputElement).checked).toBe(false);
    expect((input('选择当前筛选的全部收藏') as HTMLInputElement).indeterminate).toBe(true);
    await change(input('来源筛选'), 'bilibili');
    expect(container.textContent).toContain('已选 0 条');
    expect(button('批量忽略').disabled).toBe(true);
  });
  it('批量失败保留选择并允许重试；延期使用统一未来时间', async () => {
    state.favorites = [record('one'), record('two')];
    await mount(<DashboardApp />);
    await click(input('选择当前筛选的全部收藏'));
    failNext = '本地配额不足';
    await click(button('批量忽略'));
    expect(container.textContent).toContain('本地配额不足');
    expect(container.textContent).toContain('已选 2 条');
    await change(input('批量延期'), '3');
    const batch = requests('BATCH_UPDATE_FAVORITES').at(-1)!;
    expect(batch).toEqual({ type: 'BATCH_UPDATE_FAVORITES', ids: ['one', 'two'], change: { kind: 'postpone', reviewAt: now + 3 * day } });
    expect(state.favorites.every(item => item.reviewAt === now + 3 * day)).toBe(true);
  });
  it('可选集中方式不改变已有通知开关，旧设置默认单条', async () => {
    state.settings.notificationsEnabled = false;
    await mount(<SettingsApp />);
    expect(input('提醒方式').value).toBe('single');
    await change(input('提醒方式'), 'digest');
    expect(requests('UPDATE_SETTINGS')).toEqual([{ type: 'UPDATE_SETTINGS', patch: { reminderMode: 'digest' } }]);
    expect(state.settings.notificationsEnabled).toBe(false);
    expect(state.settings.reminderMode).toBe('digest');
  });
});

function requests(type: AppRequest['type']) {
  return sendMessage.mock.calls.map(([request]) => request).filter(request => request.type === type);
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function mount(ui: ReactElement) {
  root = createRoot(container);
  await act(async () => { root!.render(ui); });
  await flush();
}
async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}
function button(name: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name);
  if (!found) throw new Error(`Button not found: ${name}. DOM: ${container.innerHTML}`);
  return found;
}
function input(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const direct = container.querySelector(`[aria-label="${label}"]`);
  if (direct) return direct as HTMLInputElement;
  const matchingLabel = [...container.querySelectorAll('label')].find(element => element.textContent?.trim().startsWith(label));
  const control = matchingLabel?.control ?? matchingLabel?.querySelector('input, textarea, select');
  if (!control) throw new Error(`Input not found: ${label}. DOM: ${container.innerHTML}`);
  return control as HTMLInputElement;
}
async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
}
async function storageChange(area = 'local', key = STORAGE_KEY) {
  await act(async () => { for (const listener of listeners) listener({ [key]: { newValue: structuredClone(state) } }, area); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  state = { schemaVersion: 1, favorites: [], settings: { defaultReviewDays: 3, notificationsEnabled: true, bilibiliEnabled: true, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' }, diagnostics: [] };
  failNext = undefined;
  listeners = new Set();
  removeListener = vi.fn(listener => { listeners.delete(listener); });
  getPermissionLevel = vi.fn<() => Promise<'granted' | 'denied'>>(async () => 'granted');
  sendMessage = vi.fn(async (request: AppRequest) => {
    if (failNext) { const error = failNext; failNext = undefined; return { ok: false, error }; }
    if (request.type === 'UPDATE_FAVORITE') {
      const favorite = state.favorites.find(item => item.id === request.id);
      if (!favorite) return { ok: false, error: '记录已被删除，请刷新' };
      Object.assign(favorite, request.patch);
    } else if (request.type === 'DELETE_FAVORITE') {
      state.favorites = state.favorites.filter(item => item.id !== request.id);
    } else if (request.type === 'BATCH_UPDATE_FAVORITES') {
      for (const favorite of state.favorites.filter(item => request.ids.includes(item.id))) {
        if (request.change.kind === 'postpone') { favorite.reviewAt = request.change.reviewAt; favorite.status = 'pending'; }
        else favorite.status = request.change.kind === 'complete' ? 'completed' : 'ignored';
      }
    } else if (request.type === 'UPDATE_SETTINGS') {
      Object.assign(state.settings, request.patch);
    } else if (request.type === 'CLEAR_DATA') {
      state.favorites = [];
      state.diagnostics = [];
      delete state.quarantine;
    }
    return { ok: true, data: structuredClone(state) };
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage, getURL: (path: string) => `chrome-extension://test/${path}`, getManifest: () => ({ version: '0.1.0' }) },
    storage: { onChanged: { addListener: vi.fn(listener => { listeners.add(listener); }), removeListener } },
    notifications: { getPermissionLevel },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('管理界面 DOM 交互（Chrome API 模拟，不能替代真实 Chrome 验收）', () => {
  it('Popup 展示待复盘与最近收藏，挂载只读取状态和尝试补充已有当前页封面', async () => {
    state.favorites = [
      record('overdue', { title: '昨天错过的文章', reviewAt: now - day, createdAt: now - 10 * day }),
      record('morning', { title: '今天早上', reviewAt: new Date(2026, 9, 24, 8).getTime(), createdAt: now - 9 * day }),
      record('evening', { title: '今晚计划', reviewAt: new Date(2026, 9, 24, 20).getTime(), createdAt: now - 8 * day }),
      record('tomorrow', { title: '明天再看', createdAt: now - 1 }),
      record('completed', { title: '已经完成', status: 'completed', reviewAt: now - day, createdAt: now - 2 }),
      record('ignored', { title: '已经忽略', status: 'ignored', reviewAt: now - day, createdAt: now - 3 }),
    ];
    await mount(<PopupApp />);
    expect(container.querySelector('h1')?.textContent).toContain('4 条收藏');
    const sections = container.querySelectorAll('.popup-section');
    expect(sections[0].textContent).toContain('3 条');
    expect([...sections[0].querySelectorAll('.title-link')].map(item => item.textContent)).toEqual(['昨天错过的文章', '今天早上', '今晚计划']);
    expect([...sections[1].querySelectorAll('.title-link')].map(item => item.textContent)).toEqual(['明天再看', '已经完成', '已经忽略']);
    expect(sendMessage.mock.calls.every(([request]) => ['GET_STATE', 'REFRESH_CURRENT_COVER', 'GET_CURRENT_CAPTURE_STATUS'].includes(request.type))).toBe(true);
    expect(requests('REFRESH_CURRENT_COVER')).toEqual([{ type: 'REFRESH_CURRENT_COVER' }]);
    expect(container.textContent).not.toContain('网页信息');
    expect(container.querySelector('a[aria-label="打开偏好设置"]')?.getAttribute('href')).toBe('chrome-extension://test/options.html');
    expect(container.querySelector('.popup-footer a')?.getAttribute('href')).toBe('chrome-extension://test/dashboard.html');
    await click(button('打开：昨天错过的文章', sections[0]));
    expect(requests('OPEN_FAVORITE')).toEqual([{ type: 'OPEN_FAVORITE', id: 'overdue' }]);
    expect(requests('UPDATE_FAVORITE')).toEqual([]);
    expect(state.favorites[0]).toMatchObject({ status: 'pending', reviewAt: now - day });
  });

  it('Popup 空状态与管理入口无需任何收藏新增消息', async () => {
    await mount(<PopupApp />);
    expect(container.textContent).toContain('0 条收藏');
    expect(container.textContent).toContain('第一条收藏，从这里开始');
    expect(container.textContent).toContain('暂时没有到期内容');
    expect(requests('BILIBILI_FAVORITE')).toEqual([]);
  });

  it('Dashboard 搜索标题、备注和链接，并组合来源与状态筛选', async () => {
    state.favorites = [
      record('title', { title: 'React 入门' }),
      record('description', { title: '样式教程', description: 'CSS 布局', source: 'bilibili' }),
      record('note', { title: '复盘笔记', note: 'Revisit this', source: 'bilibili', status: 'completed' }),
      record('url', { title: '待查页面', reviewUrl: 'https://example.com/needle', status: 'ignored' }),
    ];
    await mount(<DashboardApp />);
    const titles = () => [...container.querySelectorAll('article h2')].map(element => element.textContent);
    expect(titles()).toHaveLength(4);
    for (const [query, title] of [[' REACT ', 'React 入门'], ['REVISIT', '复盘笔记'], ['needle', '待查页面']]) {
      await change(input('搜索收藏'), query);
      expect(titles()).toEqual([title]);
      expect(container.textContent).toContain('找到 1 条匹配记录');
    }
    await change(input('搜索收藏'), 'css');
    expect(titles()).toEqual([]);
    await change(input('搜索收藏'), '');
    await change(input('来源筛选'), 'bilibili');
    expect(titles()).toEqual(['样式教程', '复盘笔记']);
    await change(input('复盘状态筛选'), 'completed');
    expect(titles()).toEqual(['复盘笔记']);
    await change(input('搜索收藏'), '无匹配关键词');
    expect(titles()).toEqual([]);
    expect(container.textContent).toContain('暂时没有匹配的收藏');
    expect(requests('UPDATE_FAVORITE')).toEqual([]);
  });

  it('Dashboard 打开原始内容只发打开消息，不改变复盘状态和时间', async () => {
    state.favorites = [record('one')];
    await mount(<DashboardApp />);
    await click(button('打开：收藏 one'));
    expect(requests('OPEN_FAVORITE')).toEqual([{ type: 'OPEN_FAVORITE', id: 'one' }]);
    expect(requests('UPDATE_FAVORITE')).toEqual([]);
    expect(state.favorites[0]).toMatchObject({ status: 'pending', reviewAt: now + day });
  });
  it('恢复历史封面懒加载，继续隐藏简介和摘要并保留个人备注与状态', async () => {
    state.favorites = [record('legacy', {
      description: '不应显示的历史简介', summary: '不应显示的历史摘要', coverUrl: 'https://example.com/remote-cover.jpg',
      note: '应保留的个人备注', status: 'completed',
    })];
    await mount(<DashboardApp />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('https://example.com/remote-cover.jpg');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(container.textContent).not.toContain('不应显示');
    expect(container.textContent).toContain('应保留的个人备注');
    expect(container.textContent).toContain('已完成');
    expect(state.favorites[0]).toMatchObject({ description: '不应显示的历史简介', summary: '不应显示的历史摘要', coverUrl: 'https://example.com/remote-cover.jpg', status: 'completed' });
  });

  it('封面失效回退原图标，新封面可恢复显示且不改变收藏状态', async () => {
    state.favorites = [record('cover', { coverUrl: 'https://example.com/broken.jpg', status: 'ignored' })];
    await mount(<DashboardApp />);
    const image = container.querySelector('img')!;
    await act(async () => { image.dispatchEvent(new Event('error')); });
    expect(image.hidden).toBe(true);
    expect(container.querySelector('.favorite-cover > svg')).not.toBeNull();
    state.favorites[0].coverUrl = 'https://example.com/replaced.jpg';
    await storageChange();
    expect(container.querySelector('img')!.hidden).toBe(false);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://example.com/replaced.jpg');
    expect(state.favorites[0].status).toBe('ignored');
    expect(requests('UPDATE_FAVORITE')).toEqual([]);
  });

  it('Dashboard 今日与逾期入口只显示当天结束前待复盘记录，按提醒时间排序并支持组合筛选', async () => {
    window.history.replaceState({}, '', '/dashboard.html?view=due');
    state.favorites = [
      record('evening', { title: '今晚复盘', reviewAt: new Date(2026, 9, 24, 23, 59, 59, 999).getTime(), createdAt: now - 9 * day }),
      record('tomorrow', { title: '明天再看', reviewAt: new Date(2026, 9, 25).getTime(), createdAt: now }),
      record('completed', { title: '已完成不再提醒', status: 'completed', reviewAt: now - 4 * day }),
      record('morning', { title: '今天早上', source: 'bilibili', reviewAt: new Date(2026, 9, 24, 8).getTime(), createdAt: now - 3 * day }),
      record('overdue', { title: '昨天错过', reviewAt: now - day, createdAt: now - 1 }),
      record('ignored', { title: '已忽略不再提醒', status: 'ignored', reviewAt: now - 2 * day }),
    ];
    await mount(<DashboardApp />);
    const titles = () => [...container.querySelectorAll('article h2')].map(element => element.textContent);
    expect(input('复盘状态筛选').value).toBe('due');
    expect(titles()).toEqual(['昨天错过', '今天早上', '今晚复盘']);
    expect(container.textContent).toContain('按提醒时间排序');
    await change(input('来源筛选'), 'bilibili');
    expect(titles()).toEqual(['今天早上']);
    await change(input('来源筛选'), 'all');
    await change(input('搜索收藏'), '今晚');
    expect(titles()).toEqual(['今晚复盘']);
    await change(input('搜索收藏'), '');
    await change(input('复盘状态筛选'), 'all');
    expect(titles()[0]).toBe('明天再看');
    expect(titles()).toHaveLength(6);
  });

  it('Dashboard 到期样式在重新聚焦后更新，无需重新读取收藏', async () => {
    state.favorites = [record('boundary', { reviewAt: now + 1_000 })];
    await mount(<DashboardApp />);
    expect(container.querySelector('.review-time')?.classList.contains('overdue')).toBe(false);
    const reads = requests('GET_STATE').length;
    vi.setSystemTime(now + 1_001);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(container.querySelector('.review-time')?.classList.contains('overdue')).toBe(true);
    expect(requests('GET_STATE')).toHaveLength(reads);
  });

  it('编辑过去提醒时只改标题和备注，不回传已经过去的 reviewAt', async () => {
    state.favorites = [record('past', { reviewAt: now - day })];
    await mount(<DashboardApp />);
    await click(button('编辑'));
    await change(input('收藏标题'), '  修改后的标题  ');
    await change(input('个人备注'), '这次只补充备注');
    await click(button('保存更改'));
    expect(requests('UPDATE_FAVORITE')).toEqual([{ type: 'UPDATE_FAVORITE', id: 'past', patch: { title: '修改后的标题', note: '这次只补充备注' } }]);
    expect(state.favorites[0].reviewAt).toBe(now - day);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('编辑自定义未来提醒，并阻止空标题或过去时间提交', async () => {
    state.favorites = [record('custom-time')];
    await mount(<DashboardApp />);
    await click(button('编辑'));
    await change(input('收藏标题'), '   ');
    await click(button('保存更改'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('请输入收藏标题。');
    expect(requests('UPDATE_FAVORITE')).toEqual([]);
    await change(input('收藏标题'), '收藏 custom-time');
    await change(input('下次提醒'), '2026-10-23T18:30');
    await click(button('保存更改'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('请选择未来的提醒时间。');
    expect(requests('UPDATE_FAVORITE')).toEqual([]);
    await change(input('下次提醒'), '2026-10-28T18:30');
    await click(button('保存更改'));
    expect(requests('UPDATE_FAVORITE')).toEqual([{ type: 'UPDATE_FAVORITE', id: 'custom-time', patch: { reviewAt: new Date(2026, 9, 28, 18, 30).getTime() } }]);
  });

  it('完成、延期和忽略均显式更新后台，并从当前时间计算延期', async () => {
    state.favorites = [record('complete'), record('postpone', { reviewAt: now - 2 * day }), record('ignore')];
    await mount(<DashboardApp />);
    const card = (id: string) => container.querySelector(`[aria-labelledby="favorite-${id}"]`)!;
    await click(button('完成复盘', card('complete')));
    expect(card('complete').textContent).toContain('已完成');
    await change(input('延期提醒：收藏 postpone'), '3');
    await click(button('忽略', card('ignore')));
    expect(card('ignore').textContent).toContain('已忽略');
    expect(requests('UPDATE_FAVORITE')).toEqual([
      { type: 'UPDATE_FAVORITE', id: 'complete', patch: { status: 'completed' } },
      { type: 'UPDATE_FAVORITE', id: 'postpone', patch: { reviewAt: now + 3 * day } },
      { type: 'UPDATE_FAVORITE', id: 'ignore', patch: { status: 'ignored' } },
    ]);
  });

  it('删除前必须确认，取消不会发送，确认后删除记录与提醒', async () => {
    state.favorites = [record('delete')];
    await mount(<DashboardApp />);
    await click(button('删除'));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('删除这条收藏？');
    expect(requests('DELETE_FAVORITE')).toEqual([]);
    await click(button('取消'));
    expect(requests('DELETE_FAVORITE')).toEqual([]);
    await click(button('删除'));
    await click(button('确认删除'));
    expect(requests('DELETE_FAVORITE')).toEqual([{ type: 'DELETE_FAVORITE', id: 'delete' }]);
    expect(container.querySelector('article')).toBeNull();
    expect(container.textContent).toContain('留住值得回来的内容');
  });

  it('后台错误在界面显示，失败的编辑保留输入供重试', async () => {
    state.favorites = [record('error')];
    await mount(<DashboardApp />);
    await click(button('编辑'));
    await change(input('收藏标题'), '待重试标题');
    failNext = '本地存储写入失败';
    await click(button('保存更改'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('本地存储写入失败');
    expect(input('收藏标题').value).toBe('待重试标题');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(state.favorites[0].title).toBe('收藏 error');
    await click(button('保存更改'));
    expect(state.favorites[0].title).toBe('待重试标题');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('初次读取失败显示错误并允许重新读取', async () => {
    failNext = '扩展后台暂时不可用';
    await mount(<DashboardApp />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('扩展后台暂时不可用');
    await click(button('重新加载'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('留住值得回来的内容');
  });

  it('Settings 保存 1、3、7 天预设和自定义间隔，拒绝范围外自定义值', async () => {
    await mount(<SettingsApp />);
    const radio = (value: string) => container.querySelector(`input[type="radio"][value="${value}"]`)!;
    expect((radio('3') as HTMLInputElement).checked).toBe(true);
    for (const days of [1, 3, 7]) {
      await click(radio(String(days)));
      await click(button('保存提醒偏好'));
      expect(state.settings.defaultReviewDays).toBe(days);
    }
    await click(radio('custom'));
    await change(input('自定义提醒间隔'), '0');
    await click(button('保存提醒偏好'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('请输入 1–365 之间的整数天数。');
    expect(requests('UPDATE_SETTINGS')).toHaveLength(3);
    await change(input('自定义提醒间隔'), '12');
    await click(button('保存提醒偏好'));
    expect(requests('UPDATE_SETTINGS')).toEqual([1, 3, 7, 12].map(defaultReviewDays => ({ type: 'UPDATE_SETTINGS', patch: { defaultReviewDays } })));
  });

  it('Settings 显示现有自定义设置，开关只更新相应偏好', async () => {
    state.settings.defaultReviewDays = 12;
    await mount(<SettingsApp />);
    expect(input('自定义提醒间隔').value).toBe('12');
    await click(input('到期通知'));
    await click(input('B站原生收藏监听'));
    expect(requests('UPDATE_SETTINGS')).toEqual([
      { type: 'UPDATE_SETTINGS', patch: { notificationsEnabled: false } },
      { type: 'UPDATE_SETTINGS', patch: { bilibiliEnabled: false } },
    ]);
    expect(state.settings).toEqual({ defaultReviewDays: 12, notificationsEnabled: false, bilibiliEnabled: false, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' });
  });
  it('知乎实验开关默认关闭，授权请求同步发起，授权成功才启用并提示刷新页面', async () => {
    const order: string[] = [];
    const requestPermission = vi.fn(() => { order.push('permission'); return Promise.resolve(true); });
    Object.assign(chrome, { permissions: { request: requestPermission } });
    await mount(<SettingsApp />);
    const toggle = input('知乎原生收藏监听（实验性）') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => { if (message.type === 'UPDATE_SETTINGS') order.push('settings'); return original(message); });
    await click(toggle);
    expect(order).toEqual(['permission', 'settings']);
    expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*'] });
    expect(requests('UPDATE_SETTINGS')).toEqual([{ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: true } }]);
    expect(state.settings.zhihuEnabled).toBe(true);
    expect(container.textContent).toContain('已打开页面如未生效，请刷新');
  });
  it.each(['denied', 'rejected', 'missing'])('知乎授权 %s 时保持关闭并给出错误，不发送开启消息', async result => {
    const requestPermission = result === 'missing' ? undefined : vi.fn(async () => { if (result === 'rejected') throw new Error('denied'); return false; });
    Object.assign(chrome, { permissions: requestPermission ? { request: requestPermission } : undefined });
    await mount(<SettingsApp />);
    await click(input('知乎原生收藏监听（实验性）'));
    expect(state.settings.zhihuEnabled).toBe(false);
    expect(requests('UPDATE_SETTINGS')).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('监听保持关闭');
  });
  it('关闭知乎监听不再申请权限，来源筛选显示知乎', async () => {
    state.settings.zhihuEnabled = true;
    const permission = vi.fn(); Object.assign(chrome, { permissions: { request: permission } });
    await mount(<SettingsApp />);
    await click(input('知乎原生收藏监听（实验性）'));
    expect(requests('UPDATE_SETTINGS')).toEqual([{ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: false } }]);
    expect(permission).not.toHaveBeenCalled();
    await act(async () => { root!.unmount(); }); root = undefined;
    state.favorites = [record('zhihu', { source: 'zhihu' }), record('chrome')];
    await mount(<DashboardApp />);
    await change(input('来源筛选'), 'zhihu');
    expect([...container.querySelectorAll('article h2')].map(element => element.textContent)).toEqual(['收藏 zhihu']);
  });

  it('X默认关闭，用户手势中只申请x.com权限，授权后才开启', async () => {
    const permission = vi.fn(async () => true); Object.assign(chrome, { permissions: { request: permission } });
    await mount(<SettingsApp />); const toggle = input('X 原生收藏监听（实验性）') as HTMLInputElement;
    expect(toggle.checked).toBe(false); expect(permission).not.toHaveBeenCalled(); await click(toggle);
    expect(permission).toHaveBeenCalledExactlyOnceWith({ origins: ['https://x.com/*'] });
    expect(requests('UPDATE_SETTINGS')).toEqual([{ type: 'UPDATE_SETTINGS', patch: { xEnabled: true } }]);
    expect(state.settings.xEnabled).toBe(true); expect(container.textContent).toContain('只记录确认成功的收藏');
  });
  it.each(['denied','rejected','missing'])('X授权%s不能开启，其他来源偏好保持原值', async result => {
    const permission = result === 'missing' ? undefined : vi.fn(async () => { if (result === 'rejected') throw new Error('denied'); return false; });
    Object.assign(chrome, { permissions: permission ? { request: permission } : undefined });
    await mount(<SettingsApp />); await click(input('X 原生收藏监听（实验性）'));
    expect(state.settings.xEnabled).toBe(false); expect(state.settings.bilibiliEnabled).toBe(true); expect(requests('UPDATE_SETTINGS')).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('监听保持关闭');
  });
  it('X来源筛选、预览展示和搜索复用收藏库，预览按文本转义', async () => {
    state.favorites = [record('x', {source:'x',postId:'1900000000000000001',textPreview:'预览专属needle <img src=x onerror=alert(1)>',originalUrl:'https://x.com/a/status/1900000000000000001',reviewUrl:'https://x.com/a/status/1900000000000000001'}),record('chrome')];
    await mount(<DashboardApp />); await change(input('来源筛选'),'x');
    expect([...container.querySelectorAll('article h2')].map(el=>el.textContent)).toEqual(['收藏 x']);
    expect(container.querySelector('[aria-label="X 帖子文本预览"]')?.textContent).toContain('预览专属needle');
    expect(container.querySelectorAll('article img')).toHaveLength(0);
    await change(input('搜索收藏'),'needle'); expect(container.querySelectorAll('article.favorite-card')).toHaveLength(1);
    expect(requests('X_BOOKMARK')).toEqual([]);
  });
  it('关闭X监听无需重新授权，也不改变知乎设置', async () => {
    state.settings.xEnabled=true; const permission=vi.fn(); Object.assign(chrome,{permissions:{request:permission}});
    await mount(<SettingsApp />); await click(input('X 原生收藏监听（实验性）'));
    expect(permission).not.toHaveBeenCalled(); expect(requests('UPDATE_SETTINGS')).toEqual([{type:'UPDATE_SETTINGS',patch:{xEnabled:false}}]); expect(state.settings.zhihuEnabled).toBe(false);
  });

  it('Settings 清空需要输入确认，清除收藏与诊断但保留偏好设置', async () => {
    state.favorites = [record('clear')];
    state.diagnostics = [{ at: now, message: '通知被系统拒绝' }];
    state.settings = { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' };
    await mount(<SettingsApp />);
    await click(button('清空收藏与提醒'));
    expect(button('确认清空').disabled).toBe(true);
    await click(button('确认清空'));
    expect(requests('CLEAR_DATA')).toEqual([]);
    await change(input('请输入「清空」以确认'), '清空 ');
    expect(button('确认清空').disabled).toBe(true);
    await click(button('取消'));
    expect(requests('CLEAR_DATA')).toEqual([]);
    await click(button('清空收藏与提醒'));
    expect(input('请输入「清空」以确认').value).toBe('');
    await change(input('请输入「清空」以确认'), '清空');
    await click(button('确认清空'));
    expect(requests('CLEAR_DATA')).toEqual([{ type: 'CLEAR_DATA' }]);
    expect(state.favorites).toEqual([]);
    expect(state.diagnostics).toEqual([]);
    expect(state.settings).toEqual({ defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' });
    expect(container.textContent).toContain('收藏与提醒已清空，偏好设置已保留');
  });

  it('Settings 显示版本、Chrome 通知状态与后台诊断', async () => {
    state.diagnostics = [{ at: now, message: '解析受权限限制，已保留标题与 URL' }];
    await mount(<SettingsApp />);
    expect(container.textContent).toContain('BookMind Next 0.1.0');
    expect(container.textContent).toContain('Chrome 通知权限：已允许');
    expect(container.textContent).toContain('解析受权限限制，已保留标题与 URL');
    expect(getPermissionLevel).toHaveBeenCalledOnce();
  });

  it('Settings 仅有隔离数据时说明本机保留且不执行提醒，可确认清空并保留设置', async () => {
    state.settings = { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: true, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' };
    state.quarantine = [
      { kind: 'favorite', reason: 'invalid timestamp', value: { title: '私密隔离标题', reviewAt: 'bad' } },
      { kind: 'settings', reason: 'invalid interval', value: { customSecret: '不应显示的原始值' } },
    ];
    await mount(<SettingsApp />);
    const health = container.querySelector('[aria-label="隔离数据"]');
    expect(health?.textContent).toContain('已隔离 2 条异常数据');
    expect(health?.textContent).toContain('原始值仍保存在本机');
    expect(health?.textContent).toContain('不会进入收藏列表或执行提醒');
    expect(container.textContent).not.toContain('私密隔离标题');
    expect(container.textContent).not.toContain('不应显示的原始值');
    expect(button('清空收藏与提醒').disabled).toBe(false);
    await click(button('清空收藏与提醒'));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('及隔离数据将从本机移除');
    expect(requests('CLEAR_DATA')).toEqual([]);
    await change(input('请输入「清空」以确认'), '清空');
    await click(button('确认清空'));
    expect(requests('CLEAR_DATA')).toEqual([{ type: 'CLEAR_DATA' }]);
    expect(state.quarantine).toBeUndefined();
    expect(state.settings).toEqual({ defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: true, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' });
    expect(container.querySelector('[aria-label="隔离数据"]')).toBeNull();
    expect(button('清空收藏与提醒').disabled).toBe(true);
  });

  it('Settings 如实显示被阻止的 Chrome 通知状态', async () => {
    getPermissionLevel.mockResolvedValue('denied');
    await mount(<SettingsApp />);
    expect(container.textContent).toContain('Chrome 通知权限：已阻止');
  });

  it('本地 storage 变化刷新数据，其他区域忽略，卸载后解除订阅', async () => {
    await mount(<DashboardApp />);
    expect(listeners.size).toBe(1);
    const reads = requests('GET_STATE').length;
    state.favorites = [record('external', { title: '后台新保存的收藏' })];
    await storageChange('sync');
    expect(requests('GET_STATE')).toHaveLength(reads);
    await storageChange('local', 'unrelated.preference');
    expect(requests('GET_STATE')).toHaveLength(reads);
    expect(container.querySelector('article')).toBeNull();
    await storageChange();
    expect(requests('GET_STATE')).toHaveLength(reads + 1);
    expect(container.querySelector('article')?.textContent).toContain('后台新保存的收藏');
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(removeListener).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    await storageChange();
    expect(requests('GET_STATE')).toHaveLength(reads + 1);
  });
});
