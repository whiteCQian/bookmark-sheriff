import type { AppRequest } from '../models/messages';
import { bilibiliIdentity, safeWebUrl, zhihuIdentity, xPostIdentity } from '../utils/url';
import { FavoriteService } from './favorite.service';
import { savedNotice, type CaptureFeedbackMode, type CaptureResult } from '../models/capture';
import { hasZhihuPermission } from './site-registration.service';
import { updateFavoritesBatch } from './batch.service';
import type { CoverResult } from './cover.service';
import { currentCaptureStatus } from './capture-status.service';
import { hasXPermission } from './x-registration.service';

export function isBilibiliSender(sender: chrome.runtime.MessageSender): boolean {
  const url = safeWebUrl(sender.url);
  return sender.frameId === 0 && !!url && new URL(url).origin === 'https://www.bilibili.com' && !!bilibiliIdentity(url);
}

export function isZhihuSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.frameId === 0 && typeof sender.url === 'string' && !!zhihuIdentity(sender.url);
}

export function isXSender(sender: chrome.runtime.MessageSender): boolean {
  const safe = safeWebUrl(sender.url);
  if (!safe || sender.id !== chrome.runtime.id || sender.frameId !== 0) return false;
  const url = new URL(safe);
  return url.protocol === 'https:' && url.hostname === 'x.com' && !url.port;
}

export function createMessageRouter(
  favorites: FavoriteService,
  changed: () => Promise<void>,
  open: (url: string) => Promise<unknown>,
  feedback?: { capture: (result: CaptureResult, tabId: number, mode?: CaptureFeedbackMode) => Promise<void>; clear: () => Promise<void>; failed?: (url: string, tabId: number, mode?: CaptureFeedbackMode) => Promise<void> },
  covers?: { updateSaved: (tabId: number, recordId: string) => Promise<unknown>; refreshCurrentSavedPage: () => Promise<CoverResult> },
) {
  return async (raw: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) throw new Error('消息格式无效');
    const request = raw as AppRequest;
    const isExtensionPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
    if (request.type === 'GET_CAPTURE_SETTINGS') {
      const settings = (await favorites.storage.snapshot()).settings;
      if (isBilibiliSender(sender)) return { bilibiliEnabled: settings.bilibiliEnabled };
      if (isZhihuSender(sender)) return { zhihuEnabled: settings.zhihuEnabled && await hasZhihuPermission() };
      if (isXSender(sender)) return { xEnabled: settings.xEnabled && await hasXPermission() };
      throw new Error('无权读取设置');
    }
    if (request.type === 'X_BOOKMARK') {
      if (!isXSender(sender) || sender.tab?.id === undefined) throw new Error('X 收藏事件来源无效');
      const identity = typeof request.url === 'string' ? xPostIdentity(request.url) : undefined;
      if (!identity || identity.postId !== request.postId || !['add', 'remove'].includes(request.action)) throw new Error('X 帖子或收藏操作无效');
      if (!(await favorites.storage.snapshot()).settings.xEnabled || !(await hasXPermission())) return undefined;
      // Cancellation acknowledges site state; existing local review tasks remain intact.
      if (request.action === 'remove') return { action: 'remove', confirmed: true, postId: identity.postId };
      if (typeof request.preview !== 'string' || Array.from(request.preview).length > 280) throw new Error('X 文本预览无效');
      const preview = request.preview.replace(/\s+/g, ' ').trim();
      const title = Array.from(preview).slice(0, 80).join('') || `X 帖子 ${identity.postId}`;
      let result: CaptureResult;
      try { result = await favorites.captureWithResult('x', {
        title, originalUrl: request.url, reviewUrl: identity.reviewUrl, contentType: 'unknown',
        postId: identity.postId, textPreview: preview,
      }); } catch (error) {
        try { await feedback?.failed?.(request.url, sender.tab.id, 'receipt'); } catch { /* Preserve original save error. */ }
        throw error;
      }
      try { await feedback?.capture(result, sender.tab.id, 'receipt'); } catch (error) { console.warn('BookMind 收藏提示不可用', error); }
      try { await changed(); } catch (error) { console.warn('BookMind 调度刷新失败', error); }
      return { ...result.record, captureNotice: savedNotice(result) };
    }
    if (request.type === 'ZHIHU_FAVORITE') {
      if (!isZhihuSender(sender) || sender.tab?.id === undefined) throw new Error('收藏事件来源无效');
      const identity = typeof request.url === 'string' ? zhihuIdentity(request.url) : undefined;
      const current = zhihuIdentity(sender.url!);
      if (!identity || identity.reviewUrl !== current?.reviewUrl) throw new Error('知乎页面已切换，请重新收藏');
      if (!(await favorites.storage.snapshot()).settings.zhihuEnabled || !(await hasZhihuPermission())) return undefined;
      let result: CaptureResult;
      try {
        result = await favorites.captureWithResult('zhihu', {
          title: typeof request.title === 'string' ? request.title : request.url,
          originalUrl: request.url, reviewUrl: identity.reviewUrl, contentType: 'unknown',
        });
      } catch (error) {
        try { await feedback?.failed?.(request.url, sender.tab.id); } catch { /* Keep the storage error. */ }
        throw error;
      }
      try { await feedback?.capture(result, sender.tab.id); } catch (error) { console.warn('BookMind 收藏提示不可用', error); }
      try { await changed(); } catch (error) { console.warn('BookMind 调度刷新失败', error); }
      if (covers) void covers.updateSaved(sender.tab.id, result.record.id).catch(() => undefined);
      return result.record;
    }
    if (request.type === 'BILIBILI_FAVORITE') {
      if (!isBilibiliSender(sender) || sender.tab?.id === undefined) throw new Error('收藏事件来源无效');
      const identity = bilibiliIdentity(request.url);
      const senderIdentity = bilibiliIdentity(sender.url!);
      if (!identity || identity.bvId !== senderIdentity?.bvId || identity.episode !== senderIdentity.episode) throw new Error('视频页面已切换，请重新收藏');
      if (!(await favorites.storage.snapshot()).settings.bilibiliEnabled) return undefined;
      let result: CaptureResult;
      try { result = await favorites.captureWithResult('bilibili', {
        title: typeof request.title === 'string' ? request.title : identity.bvId,
        originalUrl: request.url, reviewUrl: identity.reviewUrl, contentType: 'video',
        bvId: identity.bvId, episode: identity.episode,
      }); } catch (error) {
        try { await feedback?.failed?.(request.url, sender.tab.id); } catch { /* Capture failure remains the original error. */ }
        throw error;
      }
      // A committed save stays successful even if its receipt cannot be shown.
      try { await feedback?.capture(result, sender.tab.id); } catch (error) { console.warn('BookMind 收藏提示不可用', error); }
      try { await changed(); } catch (error) { console.warn('BookMind 调度刷新失败', error); }
      if (covers) void covers.updateSaved(sender.tab.id, result.record.id).catch(() => undefined);
      return result.record;
    }
    if (!isExtensionPage) throw new Error('仅扩展管理页面可以执行此操作');
    switch (request.type) {
      case 'GET_CURRENT_CAPTURE_STATUS': {
        const { settings } = await favorites.storage.snapshot();
        return currentCaptureStatus(settings.zhihuEnabled, settings.xEnabled);
      }
      case 'GET_STATE': return favorites.storage.snapshot();
      case 'REFRESH_CURRENT_COVER': return covers ? covers.refreshCurrentSavedPage() : { status: 'unavailable' } satisfies CoverResult;
      case 'UPDATE_FAVORITE': {
        if (!request.patch || typeof request.patch !== 'object') throw new Error('更新内容无效');
        await favorites.update(request.id, request.patch);
        break;
      }
      case 'DELETE_FAVORITE': await favorites.remove(request.id); break;
      case 'BATCH_UPDATE_FAVORITES': await updateFavoritesBatch(favorites, request.ids, request.change); break;
      case 'UPDATE_SETTINGS': {
        if (!request.patch || typeof request.patch !== 'object') throw new Error('设置内容无效');
        const { defaultReviewDays, notificationsEnabled, bilibiliEnabled, zhihuEnabled, xEnabled, reminderMode } = request.patch;
        if (zhihuEnabled === true && !(await hasZhihuPermission())) throw new Error('请先允许知乎站点访问，再开启实验性监听');
        if (xEnabled === true && !(await hasXPermission())) throw new Error('请先允许 X 站点访问，再开启实验性监听');
        await favorites.settings(Object.fromEntries(Object.entries({ defaultReviewDays, notificationsEnabled, bilibiliEnabled, zhihuEnabled, xEnabled, reminderMode }).filter(([, value]) => value !== undefined)));
        break;
      }
      case 'CLEAR_DATA': await favorites.clear(); await feedback?.clear(); break;
      case 'OPEN_FAVORITE': {
        const item = (await favorites.storage.snapshot()).favorites.find(record => record.id === request.id);
        const url = safeWebUrl(item?.reviewUrl);
        if (!url) throw new Error('找不到有效的原始链接');
        await open(url);
        return undefined;
      }
      default: throw new Error('未知操作');
    }
    await changed();
    return undefined;
  };
}
