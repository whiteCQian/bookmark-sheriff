import { safeWebUrl } from '../utils/url';

interface ImportStatePort { read(): Promise<boolean>; write(value: boolean): Promise<void> }
export function registerChromeBookmarkDetector(
  bookmarks: typeof chrome.bookmarks,
  importState: ImportStatePort,
  onBookmark: (bookmark: chrome.bookmarks.BookmarkTreeNode) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  let importing = false;
  let queue: Promise<unknown> = importState.read().then(value => { importing = value; });
  const enqueue = (work: () => Promise<void>) => { queue = queue.then(work).catch(onError); };
  bookmarks.onImportBegan.addListener(() => enqueue(async () => { importing = true; await importState.write(true); }));
  bookmarks.onImportEnded.addListener(() => enqueue(async () => { importing = false; await importState.write(false); }));
  bookmarks.onCreated.addListener((_id, bookmark) => enqueue(async () => {
    if (!importing && safeWebUrl(bookmark.url)) await onBookmark(bookmark);
  }));
}
