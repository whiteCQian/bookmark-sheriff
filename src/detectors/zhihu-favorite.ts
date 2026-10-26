import { zhihuIdentity } from '../utils/url';
import type { ZhihuPageStatus, ZhihuStatusCode } from '../models/capture-status';

export const ZHIHU_SELECTORS = {
  /** Observed on a real signed-in article on 2026-10-24; extension end-to-end delivery remains unverified. */
  article: 'article.Post-Main',
  favoriteButton: '.ContentItem-actions button.ContentItem-action',
  favoriteListContent: '.Favlists-content',
  favoriteListModal: '.Modal-content',
  favoriteList: '.Favlists-items[role="list"]',
  favoriteListItem: '.Favlists-item',
  favoriteListButton: 'button.Favlists-updateButton',
  /** Answer ownership and one-click toolbar were observed live on 2026-10-25; other variants remain experimental. */
  answer: '.AnswerItem',
  answerPermalink: 'a.ContentItem-time[href], .ContentItem-time a[href], a[itemprop="url"][href], meta[itemprop="url"][content]',
  dialog: '.Modal, .Modal-content, [role="dialog"]',
  dialogAction: 'button, [role="button"], [aria-label="关闭"]',
  feedback: '.Toast, .Toast-text, [role="alert"], [role="status"]',
  loginDialog: '.SignFlow, .SignFlowModal, [role="dialog"][aria-label*="登录"]',
} as const;

const SUCCESS_TEXT = /^(收藏成功|已成功收藏|已添加到收藏夹)[!！。]?$/;
const FAILURE_TEXT = /收藏失败|收藏操作失败|取消收藏|移除收藏|移出收藏夹|请先登录|请登录|未登录|登录.{0,8}(失败|过期)|操作失败|网络.{0,8}(错误|失败)|请求.{0,8}失败/;
const CONFIRM_TEXT = /^(确定|确认|完成|保存|收藏|确定收藏|确认收藏)$/;
const CANCEL_TEXT = /^(取消|关闭|取消收藏|移出收藏夹|移除收藏)$/;

export interface ZhihuFavoriteEvent { url: string; title: string }
export interface ZhihuDetectorOptions {
  document: Document;
  window: Window;
  onFavorite: (event: ZhihuFavoriteEvent) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Experimental support is off unless its caller explicitly enables it. */
  enabled?: boolean;
  /** Tests may inject trusted clicks. Production uses the browser's isTrusted value. */
  isTrustedClick?: (event: MouseEvent) => boolean;
  candidateTimeoutMs?: number;
  selectionTimeoutMs?: number;
  directConfirmMs?: number;
  throttleMs?: number;
}

interface Candidate {
  identity: string;
  button: Element;
  owner: Element;
  confirmed: boolean;
  sawDialog: boolean;
  sawSuccess: boolean;
  feedback: Map<Element, string>;
  directEligible: boolean;
  directReady?: boolean;
  favoriteRow?: { button: Element; item: Element; content: Element; modal: Element };
}

/**
 * Experimental DOM adapter. Signed-in article and one-click answer controls have live observations;
 * the user confirmed successful capture after 0.2.5 reload. Broader Chrome/failure acceptance is pending.
 * Real signed-in article observations support a trusted favorite intent followed by a trusted
 * click on the same collection row, then both that row and the toolbar changing to "已收藏".
 * A generic fallback requires a definite unfavorited -> favorited transition plus new exact
 * success feedback. The observed direct answer path requires a stable explicit ARIA transition
 * without dialogs. No observer, scan or timer is started before a candidate click.
 */
export function createZhihuFavoriteDetector(options: ZhihuDetectorOptions) {
  const { document, window } = options;
  const view = document.defaultView!;
  let enabled = options.enabled ?? false;
  let disposed = false;
  let candidate: Candidate | undefined;
  let observer: MutationObserver | undefined;
  let timeout: number | undefined;
  let navigationTimer: number | undefined;
  let throttle: number | undefined;
  let directTimer: number | undefined;
  let status: ZhihuPageStatus = { code: enabled ? 'ready' : 'disabled', at: Date.now() };
  const mark = (code: ZhihuStatusCode) => { status = { code, at: Date.now() }; };

  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Never break site interaction. */ } };
  const text = (element: Element) => (element.textContent ?? '').trim().replace(/\s+/g, ' ');
  const identity = () => {
    const current = zhihuIdentity(window.location.href);
    return current ? `${current.kind}:${current.questionId ?? ''}:${current.id}` : undefined;
  };
  let statusIdentity = identity();
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const disabled = (element: Element) => element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
  const favoriteState = (button: Element): boolean | null => {
    const labels = [button.getAttribute('aria-label'), button.getAttribute('title'), text(button)]
      .filter((value): value is string => value !== null).map(value => value.trim());
    if (button.getAttribute('aria-pressed') === 'true' || labels.some(value => /^(已收藏|取消收藏)$/.test(value))) return true;
    // A false pressed state, numeric count, CSS color or active class cannot establish the initial state.
    if (labels.some(value => value === '收藏')) return false;
    return null;
  };
  const resolveOwner = (button: Element): Element | undefined => {
    const current = zhihuIdentity(window.location.href);
    if (!current || !button.isConnected || !visible(button)) return undefined;
    if (current.kind === 'article') {
      const articles = Array.from(document.querySelectorAll(ZHIHU_SELECTORS.article)).filter(visible);
      const owner = button.closest(ZHIHU_SELECTORS.article);
      return articles.length === 1 && articles[0] === owner ? owner : undefined;
    }
    const owners = Array.from(document.querySelectorAll(ZHIHU_SELECTORS.answer)).filter(item => visible(item)
      && Array.from(item.querySelectorAll(ZHIHU_SELECTORS.answerPermalink)).some(link => {
        if (link.closest(ZHIHU_SELECTORS.answer) !== item) return false;
        // Read only the explicit answer permalink, never answer text or JSON-LD.
        const raw = link.getAttribute(link.matches('meta') ? 'content' : 'href');
        if (!raw) return false;
        let linked;
        try { linked = zhihuIdentity(new URL(raw, window.location.href).href); } catch { return false; }
        return linked?.kind === 'answer' && linked.id === current.id && linked.questionId === current.questionId;
      }));
    const owner = button.closest(ZHIHU_SELECTORS.answer);
    return owners.length === 1 && owners[0] === owner ? owner : undefined;
  };
  // Keep hidden nodes in the baseline, so merely revealing a pre-existing success toast cannot confirm an operation.
  const feedbackSnapshot = () => new Map(Array.from(document.querySelectorAll(ZHIHU_SELECTORS.feedback))
    .map(element => [element, text(element)]));
  const favoriteDialogs = () => Array.from(document.querySelectorAll(ZHIHU_SELECTORS.dialog))
    .filter(element => visible(element) && /收藏/.test(text(element)));
  const favoriteRowContext = (button: Element) => {
    if (!button.isConnected || !visible(button)) return undefined;
    const contents = Array.from(document.querySelectorAll(ZHIHU_SELECTORS.favoriteListContent)).filter(visible);
    if (contents.length !== 1) return undefined;
    const content = contents[0];
    const modal = content.closest(ZHIHU_SELECTORS.favoriteListModal);
    const item = button.closest(ZHIHU_SELECTORS.favoriteListItem);
    const list = item?.parentElement;
    if (!modal || !visible(modal) || !item || !list?.matches(ZHIHU_SELECTORS.favoriteList)
      || list.closest(ZHIHU_SELECTORS.favoriteListContent) !== content
      || button.closest(ZHIHU_SELECTORS.favoriteListContent) !== content
      || favoriteDialogs().some(dialog => dialog !== modal && !dialog.contains(modal) && !modal.contains(dialog))) return undefined;
    return { button, item, content, modal };
  };
  const hasLoginDialog = () => Array.from(document.querySelectorAll(ZHIHU_SELECTORS.loginDialog)).some(visible);
  const resetDirect = () => {
    if (directTimer !== undefined) window.clearTimeout(directTimer);
    directTimer = undefined;
    if (candidate) candidate.directReady = false;
  };

  const clearCandidate = (reason?: ZhihuStatusCode) => {
    if (reason) mark(reason);
    resetDirect();
    candidate = undefined;
    observer?.disconnect();
    observer = undefined;
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (throttle !== undefined) window.clearTimeout(throttle);
    if (navigationTimer !== undefined) window.clearInterval(navigationTimer);
    timeout = throttle = navigationTimer = undefined;
  };
  const checkLocation = () => {
    const currentIdentity = identity();
    if (statusIdentity !== currentIdentity) {
      statusIdentity = currentIdentity;
      clearCandidate('navigation');
    }
  };
  const armTimeout = (ms: number) => {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = window.setTimeout(() => clearCandidate('timeout'), ms);
  };
  const emit = () => {
    if (!candidate || !enabled || disposed || candidate.identity !== identity()) { clearCandidate(); return; }
    // Only these minimal page fields leave the detector; no body, image or description is read for the payload.
    const event = { url: window.location.href, title: document.title };
    clearCandidate('confirmed');
    try { void Promise.resolve(options.onFavorite(event)).catch(report); } catch (error) { report(error); }
  };
  const inspect = () => {
    throttle = undefined;
    checkLocation();
    if (!candidate || !enabled || disposed) return;
    if (resolveOwner(candidate.button) !== candidate.owner) { clearCandidate('owner_lost'); return; }
    if (hasLoginDialog()) { clearCandidate('blocked'); return; }
    if (candidate.favoriteRow) {
      // React may replace the button after its request completes. Only reuse a unique
      // control inside the exact same connected row, never another collection row.
      if (!candidate.favoriteRow.button.isConnected && candidate.favoriteRow.item.isConnected) {
        const buttons = Array.from(candidate.favoriteRow.item.querySelectorAll(ZHIHU_SELECTORS.favoriteListButton))
          .filter(button => visible(button) && button.closest(ZHIHU_SELECTORS.favoriteListItem) === candidate!.favoriteRow!.item);
        if (buttons.length === 1) candidate.favoriteRow.button = buttons[0];
      }
      const row = favoriteRowContext(candidate.favoriteRow.button);
      if (!row || row.item !== candidate.favoriteRow.item || row.content !== candidate.favoriteRow.content || row.modal !== candidate.favoriteRow.modal) {
        clearCandidate('row_lost'); return;
      }
    }
    const currentFeedback = feedbackSnapshot();
    const changes = [...currentFeedback].filter(([element, value]) => visible(element) && candidate!.feedback.get(element) !== value)
      .map(([, value]) => value);
    candidate.feedback = currentFeedback;
    // A failed/cancelled operation wins over optimistic state or success in the same mutation batch.
    if (changes.some(value => FAILURE_TEXT.test(value))) { clearCandidate('failure'); return; }
    const hasDialog = favoriteDialogs().length > 0;
    if (candidate.sawDialog && !hasDialog && !candidate.confirmed) { clearCandidate('cancelled'); return; }
    if (hasDialog && !candidate.sawDialog) {
      candidate.sawDialog = true;
      candidate.sawSuccess = false;
      mark('selecting');
      armTimeout(options.selectionTimeoutMs ?? 120_000);
    }
    if ((!candidate.sawDialog || candidate.confirmed) && changes.some(value => SUCCESS_TEXT.test(value))) candidate.sawSuccess = true;
    // Observed article path: neither toolbar state alone nor another already-favorited row is evidence.
    // The row must be the same connected control that the user trusted-clicked while it read "收藏".
    if (candidate.favoriteRow && !disabled(candidate.favoriteRow.button) && text(candidate.favoriteRow.button) === '已收藏'
      && favoriteState(candidate.button) === true) { emit(); return; }
    if (candidate.sawSuccess && favoriteState(candidate.button) === true) emit();
    if (!candidate) return;
    // Real signed-in answer observed on 2026-10-25: one trusted toolbar click,
    // no collection dialog/toast, aria-label changes to 已收藏 and survives reload.
    // Require that exact transition to remain stable; clicks/counts/CSS do not qualify.
    const directSuccess = candidate.directEligible && !candidate.sawDialog && !hasDialog
      && !candidate.favoriteRow && !disabled(candidate.button) && candidate.button.getAttribute('aria-label') === '已收藏';
    if (!directSuccess) { resetDirect(); return; }
    if (candidate.directReady) { emit(); return; }
    if (directTimer === undefined) {
      mark('direct_pending');
      directTimer = window.setTimeout(() => {
        directTimer = undefined;
        if (candidate) { candidate.directReady = true; inspect(); }
      }, options.directConfirmMs ?? 800);
    }
  };
  const scheduleInspect = () => {
    if (candidate && throttle === undefined) throttle = window.setTimeout(inspect, options.throttleMs ?? 80);
  };
  const onMutations = (records: MutationRecord[]) => {
    if (!candidate) return;
    // A modal may be inserted and dismissed before the throttled inspection runs.
    // Remember its presence, including detached nodes, so closing it cannot fall back to direct-toggle detection.
    for (const record of records) {
      if (directTimer !== undefined && record.type === 'attributes' && record.target === candidate.button) resetDirect();
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof view.Element)) continue;
        const dialogs = [node, ...node.querySelectorAll(ZHIHU_SELECTORS.dialog)]
          .filter(element => element.matches(ZHIHU_SELECTORS.dialog) && /收藏/.test(text(element)));
        if (dialogs.length && !candidate.sawDialog) {
          candidate.sawDialog = true;
          resetDirect();
          candidate.sawSuccess = false;
          mark('selecting');
          armTimeout(options.selectionTimeoutMs ?? 120_000);
        }
        const feedback = [node, ...node.querySelectorAll(ZHIHU_SELECTORS.feedback)]
          .filter(element => element.matches(ZHIHU_SELECTORS.feedback));
        if (feedback.some(element => candidate!.feedback.get(element) !== text(element) && FAILURE_TEXT.test(text(element)))) {
          clearCandidate('failure');
          return;
        }
      }
    }
    scheduleInspect();
  };
  const startCandidate = (button: Element) => {
    clearCandidate();
    const currentIdentity = identity();
    if (!currentIdentity || disabled(button) || favoriteState(button) !== false) { mark('unknown_state'); return; }
    const owner = resolveOwner(button);
    if (!owner) { mark('owner_unmatched'); return; }
    if (hasLoginDialog() || favoriteDialogs().length > 0) { mark('blocked'); return; }
    candidate = { identity: currentIdentity, button, owner, confirmed: false, sawDialog: false, sawSuccess: false, feedback: feedbackSnapshot(), directEligible: button.getAttribute('aria-label') === '收藏' };
    mark('candidate');
    observer = new view.MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'title', 'aria-label', 'aria-pressed', 'aria-hidden', 'hidden', 'style', 'disabled', 'aria-disabled', 'href'],
    });
    armTimeout(options.candidateTimeoutMs ?? 15_000);
    // This interval exists only during the bounded candidate lifetime and catches quiet SPA navigation.
    navigationTimer = window.setInterval(checkLocation, 200);
  };
  const onClick = (event: MouseEvent) => {
    if (!enabled || disposed || !(options.isTrustedClick ?? (click => click.isTrusted))(event)) return;
    checkLocation();
    const target = event.composedPath().find(node => node instanceof view.Element) as Element | undefined;
    if (!target) return;
    const button = target.closest(ZHIHU_SELECTORS.favoriteButton);
    if (button && favoriteState(button) !== null) { startCandidate(button); return; }
    if (button) { mark('unknown_state'); return; }
    const unmatched = target.closest('.ContentItem-actions button');
    if (!candidate && unmatched && /^(收藏|已收藏|取消收藏)$/.test(unmatched.getAttribute('aria-label') ?? text(unmatched))) mark('unmatched_button');
    if (!candidate) return;
    if (target.closest('.Modal-backdrop, .Modal-closeButton, [aria-label="关闭"]')) { clearCandidate('cancelled'); return; }
    const favoriteRowButton = target.closest(ZHIHU_SELECTORS.favoriteListButton);
    if (favoriteRowButton) {
      const row = favoriteRowContext(favoriteRowButton);
      if (!row || disabled(favoriteRowButton) || text(favoriteRowButton) !== '收藏'
        || resolveOwner(candidate.button) !== candidate.owner || favoriteState(candidate.button) !== false) {
        clearCandidate('row_lost'); return;
      }
      candidate.favoriteRow = row;
      candidate.sawDialog = true;
      candidate.confirmed = true;
      candidate.sawSuccess = false;
      candidate.feedback = feedbackSnapshot();
      mark('row_pending');
      armTimeout(options.candidateTimeoutMs ?? 15_000);
      return;
    }
    const action = target.closest(ZHIHU_SELECTORS.dialogAction);
    const dialog = action?.closest(ZHIHU_SELECTORS.dialog);
    if (!action || !dialog || !visible(dialog) || !/收藏/.test(text(dialog))) return;
    candidate.sawDialog = true;
    const label = text(action) || action.getAttribute('aria-label') || '';
    if (CANCEL_TEXT.test(label) || action.matches('.Modal-closeButton, [aria-label="关闭"]')) { clearCandidate('cancelled'); return; }
    if (CONFIRM_TEXT.test(label) && !disabled(action)) {
      candidate.confirmed = true;
      candidate.sawSuccess = false;
      candidate.feedback = feedbackSnapshot();
      mark('row_pending');
      armTimeout(options.candidateTimeoutMs ?? 15_000);
    }
  };
  const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && candidate) clearCandidate('cancelled'); };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('popstate', checkLocation);
  window.addEventListener('hashchange', checkLocation);
  window.addEventListener('wxt:locationchange', checkLocation);

  return {
    setEnabled(value: boolean) { if (enabled !== value) mark(value ? 'ready' : 'disabled'); enabled = value; if (!value) clearCandidate(); },
    getStatus(): ZhihuPageStatus { checkLocation(); return { ...status }; },
    checkLocation,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearCandidate();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('popstate', checkLocation);
      window.removeEventListener('hashchange', checkLocation);
      window.removeEventListener('wxt:locationchange', checkLocation);
    },
  };
}
