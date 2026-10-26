import { xPostIdentity } from '../utils/url';

/** Experimental selectors: fixed-page coverage is not live X acceptance. */
export const X_BOOKMARK_SELECTORS = {
  article: 'article[data-testid="tweet"]',
  control: 'button[data-testid="bookmark"], button[data-testid="removeBookmark"], [role="button"][data-testid="bookmark"], [role="button"][data-testid="removeBookmark"]',
  text: '[data-testid="tweetText"]',
  quote: '[data-testid="quoteTweet"], [data-testid="card.wrapper"], div[role="link"]',
  feedback: '[data-testid="toast"], [role="status"], [role="alert"]',
  dialog: '[role="dialog"], [data-testid="sheetDialog"]',
} as const;

const ADD_SUCCESS = /^(?:(?:Post|Tweet) )?Added to (?:your )?Bookmarks[.!！。]?$|^(?:已添加到(?:你(?:的)?)?书签|已保存到书签)[!！。]?$/i;
const REMOVE_SUCCESS = /^(?:(?:Post|Tweet) )?Removed from (?:your )?Bookmarks[.!！。]?$|^(?:已从(?:你(?:的)?)?书签(?:中)?移除|已移除书签|已取消收藏)[!！。]?$/i;
const FAILURE = /something went wrong|try again|could not|unable to|failed|出错|失败|重试|请(?:先)?登录/i;
const UNDO = /^(?:Undo|Cancel|撤销|取消)$/i;

export interface XBookmarkEvent { url: string; postId: string; preview: string; action: 'add' | 'remove' }
export interface XBookmarkDetectorOptions {
  document: Document;
  window: Window;
  enabled?: boolean;
  onBookmark: (event: XBookmarkEvent) => void | Promise<void>;
  onError?: (error: unknown) => void;
  isTrustedClick?: (event: MouseEvent) => boolean;
  candidateTimeoutMs?: number;
  settleMs?: number;
}
interface Candidate {
  article: Element;
  control: Element;
  postId: string;
  url: string;
  page: string;
  action: 'add' | 'remove';
  feedback: Map<Element, string>;
  sawSuccess: boolean;
  settled: boolean;
}

/**
 * One bounded operation at a time prevents global toast messages from being
 * combined across unrelated posts. Only the clicked article's own timestamp
 * permalink and visible tweetText are read; no body/network/structured data.
 */
export function createXBookmarkDetector(options: XBookmarkDetectorOptions) {
  const { document, window } = options;
  const view = document.defaultView!;
  let enabled = options.enabled ?? false;
  let disposed = false;
  let candidate: Candidate | undefined;
  let observer: MutationObserver | undefined;
  let expiry: number | undefined;
  let navigation: number | undefined;
  let throttle: number | undefined;
  let settle: number | undefined;
  let quietUntil = 0;
  let statusPage = window.location.href;
  let status = { code: enabled ? 'ready' : 'disabled', at: Date.now() };
  const mark = (code: string) => { status = { code, at: Date.now() }; };
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Never interrupt X. */ } };
  const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  const allowed = () => {
    try { const url = new URL(window.location.href); return url.origin === 'https://x.com' && !/^\/(?:login|i\/flow)(?:\/|$)/.test(url.pathname); }
    catch { return false; }
  };
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const disabled = (element: Element) => element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
  const owns = (article: Element, element: Element) => element.closest(X_BOOKMARK_SELECTORS.article) === article
    && !element.closest(X_BOOKMARK_SELECTORS.quote);
  const identity = (article: Element) => {
    if (!article.isConnected || !visible(article)) return undefined;
    const identities = Array.from(article.querySelectorAll('a[href]')).filter(link => owns(article, link) && !link.closest(X_BOOKMARK_SELECTORS.text)
      && Array.from(link.querySelectorAll('time')).some(time => owns(article, time)))
      .map(link => {
        try { return xPostIdentity(new URL(link.getAttribute('href')!, window.location.href).href); }
        catch { return undefined; }
      }).filter((value): value is NonNullable<typeof value> => !!value);
    const ids = new Set(identities.map(value => value.postId));
    return ids.size === 1 ? identities[0] : undefined;
  };
  const controlFor = (article: Element) => {
    const controls = Array.from(article.querySelectorAll(X_BOOKMARK_SELECTORS.control))
      .filter(control => owns(article, control) && visible(control));
    return controls.length === 1 ? controls[0] : undefined;
  };
  const previewFor = (article: Element, element: Element | undefined) => {
    if (!element) return '';
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, view.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && owns(article, parent) && visible(parent)
        && parent.closest(X_BOOKMARK_SELECTORS.text) === element) parts.push(node.textContent ?? '');
    }
    return Array.from(parts.join('').replace(/\s+/g, ' ').trim()).slice(0, 280).join('');
  };
  const feedbackSnapshot = () => {
    const snapshot = new Map<Element, string>();
    for (const root of document.querySelectorAll(X_BOOKMARK_SELECTORS.feedback)) {
      // A post quoting the literal success text must never act as site feedback.
      if (root.closest(X_BOOKMARK_SELECTORS.article)) continue;
      snapshot.set(root, text(root));
      for (const message of root.querySelectorAll('span, div')) snapshot.set(message, text(message));
    }
    return snapshot;
  };
  const resetSettle = () => {
    if (settle !== undefined) window.clearTimeout(settle);
    settle = undefined;
    if (candidate) candidate.settled = false;
  };
  const clear = (reason?: string) => {
    if (reason) mark(reason);
    if (candidate && reason && reason !== 'confirmed') quietUntil = Date.now() + (options.candidateTimeoutMs ?? 15_000);
    resetSettle();
    candidate = undefined;
    observer?.disconnect(); observer = undefined;
    if (expiry !== undefined) window.clearTimeout(expiry);
    if (navigation !== undefined) window.clearInterval(navigation);
    if (throttle !== undefined) window.clearTimeout(throttle);
    expiry = navigation = throttle = undefined;
  };
  const quarantine = (reason: string) => {
    quietUntil = Date.now() + (options.candidateTimeoutMs ?? 15_000);
    clear(reason);
  };
  const checkLocation = () => {
    if (statusPage !== window.location.href) {
      statusPage = window.location.href;
      if (candidate) quarantine('navigation'); else mark('navigation');
    }
    if (candidate && (!allowed() || candidate.page !== window.location.href)) quarantine('navigation');
  };
  const resolveCandidate = (): boolean => {
    if (!candidate) return false;
    if (!candidate.article.isConnected) {
      const replacements = Array.from(document.querySelectorAll(X_BOOKMARK_SELECTORS.article))
        .filter(article => identity(article)?.postId === candidate!.postId);
      if (replacements.length !== 1) { clear('owner_lost'); return false; }
      candidate.article = replacements[0];
    }
    const current = identity(candidate.article);
    if (current?.postId !== candidate.postId) { clear('owner_lost'); return false; }
    const control = controlFor(candidate.article);
    if (!control) { clear('owner_lost'); return false; }
    if (control !== candidate.control) { resetSettle(); candidate.control = control; }
    return true;
  };
  const inspect = () => {
    if (throttle !== undefined) window.clearTimeout(throttle);
    throttle = undefined;
    checkLocation();
    if (!candidate || !enabled || disposed || !resolveCandidate()) return;
    if (Array.from(document.querySelectorAll(X_BOOKMARK_SELECTORS.dialog)).some(visible)) { clear('blocked'); return; }
    const changes = [...feedbackSnapshot()].filter(([element, value]) => visible(element) && candidate!.feedback.get(element) !== value).map(([, value]) => value);
    if (changes.some(value => FAILURE.test(value))) { clear('failure'); return; }
    const success = candidate.action === 'add' ? ADD_SUCCESS : REMOVE_SUCCESS;
    const opposite = candidate.action === 'add' ? REMOVE_SUCCESS : ADD_SUCCESS;
    if (changes.some(value => opposite.test(value))) { clear('cancelled'); return; }
    if (changes.some(value => success.test(value))) candidate.sawSuccess = true;
    const expected = candidate.action === 'add' ? 'removeBookmark' : 'bookmark';
    if (!candidate.sawSuccess || disabled(candidate.control) || candidate.control.getAttribute('data-testid') !== expected) { resetSettle(); return; }
    if (!candidate.settled) {
      if (settle === undefined) {
        mark('confirming');
        settle = window.setTimeout(() => { settle = undefined; if (candidate) { candidate.settled = true; inspect(); } }, options.settleMs ?? 600);
      }
      return;
    }
    const ownText = Array.from(candidate.article.querySelectorAll(X_BOOKMARK_SELECTORS.text)).filter(element => owns(candidate!.article, element) && visible(element));
    if (ownText.length > 1) { clear('owner_lost'); return; }
    const preview = previewFor(candidate.article, ownText[0]);
    const event: XBookmarkEvent = { url: candidate.url, postId: candidate.postId, preview, action: candidate.action };
    clear('confirmed');
    try { void Promise.resolve(options.onBookmark(event)).catch(report); } catch (error) { report(error); }
  };
  const onMutations = (records: MutationRecord[]) => {
    if (!candidate) return;
    for (const record of records) {
      if (record.type === 'attributes' && record.target === candidate.control) resetSettle();
      const context = record.target instanceof view.Element ? record.target : record.target.parentElement;
      const feedbackRoot = context?.closest(X_BOOKMARK_SELECTORS.feedback);
      if (feedbackRoot && !feedbackRoot.closest(X_BOOKMARK_SELECTORS.article)) {
        // Reused toast text may change failure -> success before throttled inspect.
        // Keep intermediate text-node evidence, including characterData oldValue.
        const values: Array<{ element: Element; value: string }> = [];
        if (record.type === 'characterData' && context) {
          values.push({ element: context, value: record.target.textContent ?? '' });
          if (record.oldValue !== null) values.push({ element: context, value: record.oldValue });
        }
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node instanceof view.Element) values.push({ element: node, value: text(node) });
          else if (node.nodeType === view.Node.TEXT_NODE && context) values.push({ element: context, value: (node.textContent ?? '').trim() });
        }
        if (values.some(({ element, value }) => candidate!.feedback.get(element) !== value && FAILURE.test(value))) { clear('failure'); return; }
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof view.Element)) continue;
        const feedback = [node, ...node.querySelectorAll(X_BOOKMARK_SELECTORS.feedback)]
          .filter(element => element.matches(X_BOOKMARK_SELECTORS.feedback) && !element.closest(X_BOOKMARK_SELECTORS.article));
        if (feedback.some(element => candidate!.feedback.get(element) !== text(element) && FAILURE.test(text(element)))) { clear('failure'); return; }
      }
    }
    if (throttle === undefined) throttle = window.setTimeout(inspect, 50);
  };
  const start = (control: Element) => {
    clear();
    if (!allowed() || disabled(control) || !visible(control)) { mark('blocked'); return; }
    const article = control.closest(X_BOOKMARK_SELECTORS.article);
    const post = article && identity(article);
    if (!article || !post || controlFor(article) !== control) { mark('owner_unmatched'); return; }
    if (Array.from(document.querySelectorAll(X_BOOKMARK_SELECTORS.dialog)).some(visible)) { mark('blocked'); return; }
    candidate = { article, control, postId: post.postId, url: post.reviewUrl, page: window.location.href,
      action: control.getAttribute('data-testid') === 'bookmark' ? 'add' : 'remove', feedback: feedbackSnapshot(), sawSuccess: false, settled: false };
    mark('candidate');
    observer = new view.MutationObserver(onMutations);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true,
      attributeFilter: ['data-testid', 'href', 'hidden', 'aria-hidden', 'style', 'disabled', 'aria-disabled', 'role'] });
    expiry = window.setTimeout(() => quarantine('timeout'), options.candidateTimeoutMs ?? 15_000);
    navigation = window.setInterval(checkLocation, 200);
  };
  const onClick = (event: MouseEvent) => {
    if (!enabled || disposed || !(options.isTrustedClick ?? (click => click.isTrusted))(event)) return;
    checkLocation();
    const target = event.composedPath().find(node => node instanceof view.Element) as Element | undefined;
    if (!target) return;
    const control = target.closest(X_BOOKMARK_SELECTORS.control);
    if (control) {
      // Global messages have no post ID. Never attribute a late A toast to a
      // second optimistic B operation, or an old add to add/remove/add intent.
      if (candidate || Date.now() < quietUntil) { quarantine('ambiguous'); return; }
      start(control); return;
    }
    const action = target.closest('button, [role="button"]');
    if (candidate && action && UNDO.test(action.getAttribute('aria-label') ?? text(action))
      && action.closest(X_BOOKMARK_SELECTORS.feedback)) clear('cancelled');
  };
  const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && candidate) clear('cancelled'); };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('popstate', checkLocation);
  window.addEventListener('hashchange', checkLocation);
  window.addEventListener('wxt:locationchange', checkLocation);
  return {
    setEnabled(value: boolean) { if (value !== enabled) mark(value ? 'ready' : 'disabled'); enabled = value; if (!value) { if (candidate) quarantine('disabled'); else clear(); } },
    checkLocation,
    getStatus() { checkLocation(); return { ...status }; },
    dispose() {
      if (disposed) return;
      disposed = true; clear();
      document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('popstate', checkLocation); window.removeEventListener('hashchange', checkLocation); window.removeEventListener('wxt:locationchange', checkLocation);
    },
  };
}
