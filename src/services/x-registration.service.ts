import { FavoriteService } from './favorite.service';

export const X_ORIGINS = ['https://x.com/*'];
export const X_SCRIPT_ID = 'bookmind-x';

export async function hasXPermission(): Promise<boolean> {
  try { return await chrome.permissions.contains({ origins: [...X_ORIGINS] }); }
  catch { return false; }
}

function isXDocument(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'x.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

/** Optional host access only; registration covers X SPA entry points as well as posts. */
export class XRegistrationService {
  private queue: Promise<unknown> = Promise.resolve();
  private activateOpenPages = true;

  constructor(private readonly favorites: FavoriteService) {}

  reconcile(): Promise<void> {
    const next = this.queue.then(async () => {
      const { settings } = await this.favorites.storage.snapshot();
      const permitted = await hasXPermission();
      const enabled = settings.xEnabled && permitted;
      if (settings.xEnabled && !permitted) await this.favorites.settings({ xEnabled: false });
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [X_SCRIPT_ID] });
      if (!enabled) {
        this.activateOpenPages = true;
        if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [X_SCRIPT_ID] });
        return;
      }
      if (!registered.length) {
        await chrome.scripting.registerContentScripts([{
          id: X_SCRIPT_ID, matches: [...X_ORIGINS], js: ['x.js'],
          runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
        }]);
      }
      if (this.activateOpenPages || !registered.length) {
        const tabs = await chrome.tabs.query({ url: [...X_ORIGINS] });
        const results = await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && isXDocument(tab.url))
          .map(async tab => {
            try {
              const reply = await chrome.tabs.sendMessage(tab.id!, { type: 'BOOKMIND_X_STATUS' }, { frameId: 0 });
              const code = reply?.page?.code;
              if (reply?.version === chrome.runtime.getManifest().version && typeof code === 'string'
                && /^[a-z_]{1,64}$/.test(code) && code !== 'disabled' && Number.isFinite(reply.page.at)) return;
            } catch { /* Missing or invalidated context is repaired below. */ }
            await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, files: ['x.js'] });
          }));
        if (results.some(result => result.status === 'rejected')) throw new Error('部分 X 页面未能加载监听，请刷新页面后重试');
        this.activateOpenPages = false;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
