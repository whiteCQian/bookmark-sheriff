import type { CaptureNotice } from '../models/capture';

/** Self-contained: Chrome serializes this function when injecting into a page. */
export function showCaptureToast(notice: CaptureNotice, expectedUrl?: string): boolean {
  if (expectedUrl !== undefined && location.href !== expectedUrl) return false;
  if (!document.documentElement) return false;
  const id = 'bookmind-next-capture-feedback';
  const previous = document.getElementById(id);
  if (previous) { window.clearTimeout(Number(previous.dataset.dismissTimer)); previous.remove(); }
  const host = document.createElement('div');
  host.id = id;
  for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', top: '24px', right: '24px', 'z-index': '2147483647', display: 'block', width: 'min(360px, calc(100vw - 32px))', 'pointer-events': 'auto' })) host.style.setProperty(key, value, 'important');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{color-scheme:light}*{box-sizing:border-box}.notice{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fcfcf7;color:#234f40;border:1px solid #cbd8be;border-radius:14px;padding:16px 40px 16px 18px;box-shadow:0 8px 36px #163c302b;overflow-wrap:anywhere}.error{color:#7c3626;border-color:#e4b8a4}strong{display:block;font-size:14px}p{margin:5px 0 0;color:#65705b;white-space:pre-line;font-size:12px}button{position:absolute;right:10px;top:10px;border:0;border-radius:6px;background:transparent;color:#697760;cursor:pointer;width:26px;height:26px;font:20px system-ui}button:focus-visible{outline:2px solid #1e5340;outline-offset:2px}`;
  const panel = document.createElement('div');
  const failure = notice.kind === 'failed' || notice.kind === 'unconfirmed';
  panel.className = failure ? 'notice error' : 'notice';
  panel.setAttribute('role', failure ? 'alert' : 'status');
  panel.setAttribute('aria-live', failure ? 'assertive' : 'polite');
  const title = document.createElement('strong'); title.textContent = notice.title;
  const detail = document.createElement('p'); detail.textContent = notice.detail;
  const close = document.createElement('button');
  close.type = 'button'; close.setAttribute('aria-label', '关闭 BookMind 提示'); close.textContent = '×';
  const dismiss = () => { window.clearTimeout(Number(host.dataset.dismissTimer)); host.remove(); };
  close.addEventListener('click', dismiss);
  panel.append(title, detail, close);
  root.append(style, panel);
  document.documentElement.append(host);
  host.dataset.dismissTimer = String(window.setTimeout(dismiss, failure ? 10_000 : 7_000));
  return true;
}
