import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Dialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const current = useRef({ onClose, busy });
  current.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]') ?? [])];
    (focusable().find(element => element.tagName !== 'BUTTON') ?? focusable()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !current.current.busy) { event.preventDefault(); current.current.onClose(); }
      if (event.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={panel}><div className="dialog-header"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose} disabled={busy}><Icon name="close" /></button></div>{children}</div></div>;
}

export function ConfirmDialog({ title, detail, confirmLabel, onConfirm, onClose, busy, error, children, disabled = false }: { title: string; detail: string; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy: boolean; error?: string; children?: ReactNode; disabled?: boolean }) {
  return <Dialog title={title} onClose={onClose} busy={busy}><p className="dialog-description">{detail}</p>{children}{error && <div className="feedback error" role="alert">{error}</div>}<div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button danger" onClick={onConfirm} disabled={busy || disabled}>{busy ? '处理中…' : confirmLabel}</button></div></Dialog>;
}
