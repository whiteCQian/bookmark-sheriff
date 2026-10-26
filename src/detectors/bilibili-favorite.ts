/** Actual selectors observed on public B站 video pages on 2026-10-23. */
export const BILIBILI_SELECTORS = {
  favoriteButton: '.video-fav',
  /** collection-m-exp/bili-dialog-bomb observed in a signed-in page on 2026-10-25. */
  favoriteDialog: '.collection-m-exp, .collection-m, .bili-dialog-bomb, .bili-dialog-m, .bili-dialog, .fav-container, [role="dialog"]',
  nativeDialog: '.collection-m-exp',
  dialogAction: 'button, [role="button"], .btn, .submit-move, .close, .bili-dialog-close, [aria-label="关闭"]',
  feedback: '.bili-toast, .bili-message, .bili-message__content, .bili-message-content, .toast-text, [role="alert"], [role="status"]',
  loginDialog: '.bili-mini-login, .bili-mini-login-wrapper, .login-modal, [role="dialog"][aria-label*="登录"]',
} as const;

// These are defensive, unverified signed-in-state fallbacks, not a claim about the current live site.
const FAVORITED_CLASSES = ['on', 'active', 'is-active'];
const CONFIRM_TEXT = /^(确定|确认|完成|保存|收藏|确定收藏|确认收藏)$/;
const CANCEL_TEXT = /^(取消|关闭|取消收藏|移出收藏夹|移除收藏)$/;
const SUCCESS_TEXT = /^(收藏成功|已成功收藏|已添加到收藏夹)[!！。]?$/;
const FAILURE_TEXT = /收藏失败|收藏操作失败|取消收藏|请先登录|请登录|未登录|登录.{0,8}(失败|过期)|操作失败|网络.{0,8}(错误|失败)|请求.{0,8}失败/;

export interface BilibiliFavoriteEvent { url: string; title: string }
export interface BilibiliDetectorOptions {
  document: Document;
  window: Window;
  onFavorite: (event: BilibiliFavoriteEvent) => void | Promise<void>;
  onError?: (error: unknown) => void;
  enabled?: boolean;
  /** Explicitly injectable for DOM simulation. Production defaults to the browser's isTrusted. */
  isTrustedClick?: (event: MouseEvent) => boolean;
  candidateTimeoutMs?: number;
  throttleMs?: number;
  confirmationSettleMs?: number;
}

interface Candidate {
  identity: string;
  confirmed: boolean;
  sawDialog: boolean;
  feedback: Map<Element, string>;
  wasFavorited: boolean | null;
  /** Positive selection captured before the site's confirm handler runs. */
  nativeConfirmation?: Element;
  closedAt?: number;
}

/** No polling or MutationObserver remains active while idle; clicks alone never emit a favorite. */
export function createBilibiliFavoriteDetector(options: BilibiliDetectorOptions) {
  const { document, window } = options;
  const view = document.defaultView!;
  let enabled = options.enabled ?? true;
  let disposed = false;
  let candidate: Candidate | undefined;
  let observer: MutationObserver | undefined;
  let timeout: number | undefined;
  let navigationTimer: number | undefined;
  let throttle: number | undefined;
  let successTimer: number | undefined;

  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Keep website interaction unaffected. */ } };
  const identity = () => {
    const url = new URL(window.location.href);
    if (url.protocol !== 'https:' || url.hostname !== 'www.bilibili.com') return null;
    const video = url.pathname.match(/^\/video\/(BV[\da-zA-Z]{10}|av\d+)(?:\/|$)/)?.[1];
    if (!video) return null;
    const part = url.searchParams.get('p');
    return `${video}:p${part && /^[1-9]\d*$/.test(part) ? Number(part) : 1}`;
  };
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const text = (element: Element) => (element.textContent ?? '').trim().replace(/\s+/g, ' ');
  const feedbackSnapshot = () => new Map(Array.from(document.querySelectorAll(BILIBILI_SELECTORS.feedback))
    .map(element => [element, text(element)]));
  const favoriteState = (): boolean | null => {
    const button = Array.from(document.querySelectorAll(BILIBILI_SELECTORS.favoriteButton)).find(visible);
    if (!button) return null;
    const pressed = button.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    if (FAVORITED_CLASSES.some(name => button.classList.contains(name))) return true;
    const label = `${button.getAttribute('title') ?? ''} ${button.getAttribute('aria-label') ?? ''}`;
    if (/已收藏|取消收藏/.test(label)) return true;
    if (/收藏/.test(label)) return false;
    return null;
  };
  // Only this exact class was verified after native confirmation. Other generic
  // active classes can mean hover/selection and are not a successful save.
  const nativeFavorited = () => Array.from(document.querySelectorAll(BILIBILI_SELECTORS.favoriteButton)).find(visible)?.classList.contains('on') === true;

  const clearCandidate = () => {
    candidate = undefined;
    observer?.disconnect();
    observer = undefined;
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (throttle !== undefined) window.clearTimeout(throttle);
    if (navigationTimer !== undefined) window.clearInterval(navigationTimer);
    if (successTimer !== undefined) window.clearTimeout(successTimer);
    timeout = throttle = navigationTimer = successTimer = undefined;
  };
  const checkLocation = () => {
    if (candidate && candidate.identity !== identity()) clearCandidate();
  };
  const emit = () => {
    if (!candidate || !enabled || disposed || candidate.identity !== identity()) { clearCandidate(); return; }
    const event = { url: window.location.href, title: document.title };
    clearCandidate(); // Consume before invoking an async callback or observing duplicate DOM mutations.
    try { void Promise.resolve(options.onFavorite(event)).catch(report); } catch (error) { report(error); }
  };
  const inspect = () => {
    throttle = undefined;
    checkLocation();
    if (!candidate || !enabled || disposed) return;
    if (Array.from(document.querySelectorAll(BILIBILI_SELECTORS.loginDialog)).some(visible)) { clearCandidate(); return; }
    const currentFeedback = feedbackSnapshot();
    const changes = [...currentFeedback].filter(([element, value]) => visible(element) && candidate!.feedback.get(element) !== value).map(([, value]) => value);
    candidate.feedback = currentFeedback;
    // Failure wins if conflicting UI signals appear in one batch.
    if (changes.some(value => FAILURE_TEXT.test(value))) { clearCandidate(); return; }
    // Keep the previous explicit-toast path, but do not require a toast from the
    // native dialog: current signed-in B站 closes it and updates the toolbar.
    if (candidate.confirmed && changes.some(value => SUCCESS_TEXT.test(value))) emit();
    if (!candidate) return;
    const native = candidate.nativeConfirmation;
    if (native) {
      const closed = (!native.isConnected || !visible(native))
        && !Array.from(document.querySelectorAll(BILIBILI_SELECTORS.nativeDialog)).some(visible);
      if (closed && candidate.wasFavorited === false && nativeFavorited()) {
        candidate.closedAt ??= Date.now();
        const remaining = (options.confirmationSettleMs ?? 400) - (Date.now() - candidate.closedAt);
        if (remaining <= 0) { emit(); return; }
        if (successTimer === undefined) successTimer = window.setTimeout(() => { successTimer = undefined; inspect(); }, remaining);
      } else {
        if (candidate.closedAt !== undefined) { clearCandidate(); return; }
        candidate.closedAt = undefined;
        if (successTimer !== undefined) window.clearTimeout(successTimer);
        successTimer = undefined;
      }
    }
    const hasDialog = Array.from(document.querySelectorAll(BILIBILI_SELECTORS.favoriteDialog)).some(element => visible(element) && /收藏/.test(text(element)));
    if (candidate.sawDialog && !hasDialog && !candidate.confirmed) { clearCandidate(); return; }
    candidate.sawDialog ||= hasDialog;
  };
  const scheduleInspect = () => {
    if (candidate && throttle === undefined) throttle = window.setTimeout(inspect, options.throttleMs ?? 80);
  };
  const onMutations = (records: MutationRecord[]) => {
    if (!candidate) return;
    // Failure toasts can be inserted and removed before the throttled inspection.
    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof view.Element)) continue;
        const notices = [node, ...node.querySelectorAll(BILIBILI_SELECTORS.feedback)].filter(element => element.matches(BILIBILI_SELECTORS.feedback));
        if (notices.some(element => candidate!.feedback.get(element) !== text(element) && FAILURE_TEXT.test(text(element)))) { clearCandidate(); return; }
      }
    }
    scheduleInspect();
  };
  const startCandidate = () => {
    clearCandidate();
    const currentIdentity = identity();
    const state = favoriteState();
    if (!currentIdentity || state === true) return;
    candidate = { identity: currentIdentity, wasFavorited: state, confirmed: false, sawDialog: false, feedback: feedbackSnapshot() };
    observer = new view.MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'title', 'aria-label', 'aria-pressed', 'aria-hidden', 'hidden', 'style', 'checked', 'disabled', 'aria-disabled'],
    });
    timeout = window.setTimeout(clearCandidate, options.candidateTimeoutMs ?? 15_000);
    // Bounded to the candidate lifetime; catches history changes even if the page has no DOM mutation.
    navigationTimer = window.setInterval(checkLocation, 200);
  };
  const onClick = (event: MouseEvent) => {
    if (!enabled || disposed || !(options.isTrustedClick ?? (click => click.isTrusted))(event)) return;
    checkLocation();
    const target = event.composedPath().find(node => node instanceof view.Element) as Element | undefined;
    if (!target) return;
    if (target.closest(BILIBILI_SELECTORS.favoriteButton)) { startCandidate(); return; }
    const action = target.closest(BILIBILI_SELECTORS.dialogAction);
    const dialog = action?.closest(BILIBILI_SELECTORS.favoriteDialog);
    if (!action || !dialog || !visible(dialog) || !/收藏/.test(text(dialog))) return;
    const label = text(action) || action.getAttribute('aria-label') || '';
    const native = action.closest(BILIBILI_SELECTORS.nativeDialog);
    const positiveSelection = native && Array.from(native.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).some(input => input.checked);
    const canConfirm = CONFIRM_TEXT.test(label) && action.getAttribute('aria-disabled') !== 'true' && !action.hasAttribute('disabled');
    const canNativeConfirm = canConfirm && label === '确定' && action.matches('button.submit-move');
    // Choosing a folder may take longer than the initial candidate lifetime.
    // A trusted, enabled native confirm can start a fresh candidate while the
    // toolbar still explicitly describes an uncollected video.
    if (!candidate && canNativeConfirm && positiveSelection && favoriteState() === false) startCandidate();
    if (!candidate) return;
    candidate.sawDialog = true;
    if (CANCEL_TEXT.test(label) || action.matches('.close, .bili-dialog-close, [aria-label="关闭"]')) { clearCandidate(); return; }
    if (canConfirm) {
      // Submission gets a full response window even when choosing a folder took
      // almost the entire original candidate lifetime.
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(clearCandidate, options.candidateTimeoutMs ?? 15_000);
      candidate.confirmed = true;
      candidate.nativeConfirmation = canNativeConfirm && positiveSelection ? native! : undefined;
      candidate.closedAt = undefined;
      candidate.feedback = feedbackSnapshot(); // A pre-existing success message is not confirmation of this operation.
    }
  };
  // Escape can only discard a candidate, so synthetic Escape events cannot create records.
  const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape') clearCandidate(); };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('popstate', checkLocation);
  window.addEventListener('hashchange', checkLocation);
  window.addEventListener('wxt:locationchange', checkLocation);

  return {
    setEnabled(value: boolean) { enabled = value; if (!value) clearCandidate(); },
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
