import { readPageCover, type PageCover } from '../cover/read-cover';
import { contentKey, safeWebUrl } from '../utils/url';
import { FavoriteService } from './favorite.service';

export type CoverResult = { status: 'updated'; recordId: string } | { status: 'no_saved_record' | 'unavailable' };

/** Cover access is best-effort and never part of committing a favorite. */
export class CoverService {
  constructor(private readonly favorites: FavoriteService) {}

  async updateSaved(tabId: number, recordId: string): Promise<CoverResult> {
    try {
      const item = (await this.favorites.storage.snapshot()).favorites.find(record => record.id === recordId);
      if (!item) return { status: 'no_saved_record' };
      if (!(await this.samePage(tabId, item.contentKey))) return { status: 'unavailable' };
      const [injection] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: readPageCover });
      if (!(await this.samePage(tabId, item.contentKey))) return { status: 'unavailable' };
      const cover = injection?.result as Partial<PageCover> | undefined;
      if (!cover || !safeWebUrl(cover.url) || contentKey(cover.url!) !== item.contentKey) return { status: 'unavailable' };
      const image = safeWebUrl(cover.coverUrl);
      if (!image) return { status: 'unavailable' };
      return await this.favorites.setCover(item.id, image, item.contentKey)
        ? { status: 'updated', recordId: item.id } : { status: 'no_saved_record' };
    } catch { return { status: 'unavailable' }; }
  }

  async updateActiveSaved(recordId: string): Promise<CoverResult> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id === undefined ? { status: 'unavailable' } : this.updateSaved(tab.id, recordId);
    } catch { return { status: 'unavailable' }; }
  }

  async refreshCurrentSavedPage(): Promise<CoverResult> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) return { status: 'unavailable' };
      const current = await chrome.tabs.get(tab.id);
      const url = safeWebUrl(current.url);
      if (!url || current.discarded) return { status: 'unavailable' };
      const key = contentKey(url);
      const item = (await this.favorites.storage.snapshot()).favorites.find(record => record.contentKey === key);
      if (!item) return { status: 'no_saved_record' };
      return this.updateSaved(tab.id, item.id);
    } catch { return { status: 'unavailable' }; }
  }

  private async samePage(tabId: number, expectedKey: string): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId);
    const url = safeWebUrl(tab.url);
    return !!url && !tab.discarded && contentKey(url) === expectedKey
      && (!tab.pendingUrl || (!!safeWebUrl(tab.pendingUrl) && contentKey(tab.pendingUrl) === expectedKey));
  }
}
