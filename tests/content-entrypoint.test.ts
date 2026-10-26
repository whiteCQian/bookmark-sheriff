import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BilibiliDetectorOptions } from '../src/detectors/bilibili-favorite';

const mocks = vi.hoisted(() => ({ detector: vi.fn() }));
vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: (value: unknown) => value }));
vi.mock('../src/detectors/bilibili-favorite', () => ({ createBilibiliFavoriteDetector: mocks.detector }));
import content from '../entrypoints/bilibili.content';
import { CAPTURE_TOAST_ID } from '../src/models/capture';

const url = 'https://www.bilibili.com/video/BV1ex411x7Em/?p=2';
let enabled = true;
let options: BilibiliDetectorOptions;
const sendMessage = vi.fn();
let invalidate: () => void;
beforeEach(async () => {
  enabled = true;
  vi.stubGlobal('location', { href: url });
  document.title = '课程第 2 集';
  mocks.detector.mockImplementation((value: BilibiliDetectorOptions) => {
    options = value;
    return { setEnabled: vi.fn(), checkLocation: vi.fn(), dispose: vi.fn() };
  });
  sendMessage.mockReset().mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS'
    ? { ok: true, data: { bilibiliEnabled: enabled } } : { ok: true });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  (content as unknown as { main(ctx: unknown): void }).main({
    addEventListener: vi.fn(),
    onInvalidated: (callback: () => void) => { invalidate = callback; },
  });
  await Promise.resolve();
});
afterEach(() => { invalidate(); vi.unstubAllGlobals(); });

it('确认后只改变跟踪参数和锚点，仍保存当前同一分集', async () => {
  location.href = `${url}&spm_id_from=new#player`;
  await options.onFavorite({ url, title: '旧标题' });
  expect(sendMessage).toHaveBeenCalledWith({ type: 'BILIBILI_FAVORITE', url: location.href, title: document.title });
});
it('确认后切换分集，不把旧事件保存到新入口', async () => {
  location.href = url.replace('p=2', 'p=3');
  await options.onFavorite({ url, title: '旧标题' });
  expect(sendMessage.mock.calls.some(([message]) => message.type === 'BILIBILI_FAVORITE')).toBe(false);
});
it('发送前再次读取设置，关闭采集后丢弃此前候选', async () => {
  enabled = false;
  await options.onFavorite({ url, title: document.title });
  expect(sendMessage.mock.calls.some(([message]) => message.type === 'BILIBILI_FAVORITE')).toBe(false);
});

it('后台明确保存失败时显示失败提示，不冒充网站收藏失败', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS'
    ? { ok: true, data: { bilibiliEnabled: true } } : { ok: false, error: 'quota' });
  await options.onFavorite({ url, title: document.title });
  expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('BookMind 未能保存这条收藏');
  expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('原网站的收藏操作不受影响');
  warning.mockRestore();
});

it('消息连接断开时只提示结果未确认，页面切换后不显示旧结果', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  sendMessage.mockImplementation(async message => {
    if (message.type === 'GET_CAPTURE_SETTINGS') return { ok: true, data: { bilibiliEnabled: true } };
    throw new Error('connection closed');
  });
  await options.onFavorite({ url, title: document.title });
  expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('无法确认');
  document.getElementById(CAPTURE_TOAST_ID)?.remove();
  sendMessage.mockImplementation(async message => {
    if (message.type === 'GET_CAPTURE_SETTINGS') return { ok: true, data: { bilibiliEnabled: true } };
    location.href = url.replace('p=2', 'p=3');
    return { ok: false, error: 'old page' };
  });
  await options.onFavorite({ url, title: document.title });
  expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
  warning.mockRestore();
});
