import { useEffect, useState } from 'react';
import { CAPTURE_FEEDBACK_KEY, isCaptureNotice, type CaptureNotice } from '../models/capture';

/** A session receipt remains available when page/system presentation was blocked. */
export function CaptureFeedback() {
  const [notice, setNotice] = useState<CaptureNotice>();
  useEffect(() => {
    let active = true;
    let version = 0;
    const read = async () => {
      const current = ++version;
      try {
        const data = await chrome.storage.session.get(CAPTURE_FEEDBACK_KEY);
        if (active && current === version) setNotice(isCaptureNotice(data[CAPTURE_FEEDBACK_KEY]) ? data[CAPTURE_FEEDBACK_KEY] : undefined);
      } catch { /* Session receipts are supplementary; favorites remain visible. */ }
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && Object.hasOwn(changes, CAPTURE_FEEDBACK_KEY)) void read();
    };
    chrome.storage.onChanged.addListener(changed);
    void read();
    return () => { active = false; version++; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  if (!notice) return null;
  const failed = notice.kind === 'failed' || notice.kind === 'unconfirmed';
  return <section className={`capture-receipt ${failed ? 'capture-receipt-error' : ''}`} aria-label="最近收藏结果" role={failed ? 'alert' : 'status'}>
    <span>最近一次 · {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(notice.at)}</span>
    <strong>{notice.title}</strong><p>{notice.detail}</p>
  </section>;
}
