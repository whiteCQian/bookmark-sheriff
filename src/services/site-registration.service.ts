import { FavoriteService } from './favorite.service';
import { zhihuIdentity } from '../utils/url';
import { ZHIHU_STATUS_LABELS } from '../models/capture-status';

export const ZHIHU_ORIGINS = ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*'];
export const ZHIHU_SCRIPT_ID = 'bookmind-zhihu';

export async function hasZhihuPermission(): Promise<boolean> {
  try { return await chrome.permissions.contains({ origins: [...ZHIHU_ORIGINS] }); }
  catch { return false; }
}

/** Opt-in only. Unregistering stops future injection; settings also stop live candidates. */
export class SiteRegistrationService {
  private queue: Promise<unknown> = Promise.resolve();
  private activateOpenPages = true;
  constructor(private readonly favorites: FavoriteService) {}

  reconcile(): Promise<void> {
    const next = this.queue.then(async () => {
      const { settings } = await this.favorites.storage.snapshot();
      const permitted = await hasZhihuPermission();
      const enabled = settings.zhihuEnabled && permitted;
      if (settings.zhihuEnabled && !permitted) await this.favorites.settings({ zhihuEnabled: false });
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [ZHIHU_SCRIPT_ID] });
      if (!enabled) {
        this.activateOpenPages = true;
        if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [ZHIHU_SCRIPT_ID] });
        return;
      }
      if (!registered.length) await chrome.scripting.registerContentScripts([{
        id: ZHIHU_SCRIPT_ID,
        matches: ['https://zhuanlan.zhihu.com/p/*', 'https://www.zhihu.com/question/*/answer/*'],
        js: ['zhihu.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
      }]);
      if (this.activateOpenPages || !registered.length) {
        // Dynamic registration applies to future documents only. Activate already
        // open detail pages after opt-in as well, without reloading the user's page.
        const tabs = await chrome.tabs.query({ url: [...ZHIHU_ORIGINS] });
        const results = await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && !!zhihuIdentity(tab.url ?? ''))
          .map(async tab => {
            // Worker wake-ups must not replace a healthy listener during its
            // success/settings/save handshake. Only repair missing/old contexts.
            try {
              const reply = await chrome.tabs.sendMessage(tab.id!, { type: 'BOOKMIND_ZHIHU_STATUS' }, { frameId: 0 });
              if (reply?.version === chrome.runtime.getManifest().version && reply.page
                && reply.page.code !== 'disabled'
                && Object.hasOwn(ZHIHU_STATUS_LABELS, reply.page.code) && Number.isFinite(reply.page.at)) return;
            } catch { /* Missing listener or invalid old context: inject below. */ }
            await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, files: ['zhihu.js'] });
          }));
        if (results.some(result => result.status === 'rejected')) throw new Error('部分知乎页面未能加载监听，请刷新知乎详情页后重试');
        this.activateOpenPages = false;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
