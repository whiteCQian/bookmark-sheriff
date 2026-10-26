import { useState, type FormEvent } from 'react';
import type { FavoriteRecord } from '../models/favorite';
import type { AppRequest } from '../models/messages';
import { toLocalDateTime } from '../ui/format';
import { Dialog } from './Dialog';

type FavoritePatch = Extract<AppRequest, { type: 'UPDATE_FAVORITE' }>['patch'];
export function FavoriteEditor({ item, onSave, onClose, busy, error }: { item: FavoriteRecord; onSave: (patch: FavoritePatch) => Promise<boolean>; onClose: () => void; busy: boolean; error: string }) {
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');
  const originalTime = toLocalDateTime(item.reviewAt);
  const [time, setTime] = useState(originalTime);
  const [validation, setValidation] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setValidation('');
    if (!title.trim()) { setValidation('请输入收藏标题。'); return; }
    const patch: FavoritePatch = {};
    if (title.trim() !== item.title) patch.title = title.trim();
    if (note !== (item.note ?? '')) patch.note = note;
    // Unchanged past reminders remain valid when editing only the title or note.
    if (time !== originalTime) {
      const timestamp = new Date(time).getTime();
      if (!Number.isFinite(timestamp) || timestamp <= Date.now()) { setValidation('请选择未来的提醒时间。'); return; }
      patch.reviewAt = timestamp;
    }
    if (!Object.keys(patch).length || await onSave(patch)) onClose();
  }
  return <Dialog title="编辑收藏" onClose={onClose} busy={busy}><form onSubmit={event => { void save(event); }} noValidate><label className="field-label" htmlFor="favorite-title">收藏标题</label><input id="favorite-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={500} required disabled={busy} aria-invalid={!title.trim() && !!validation} /><label className="field-label" htmlFor="favorite-note">个人备注 <span>可选</span></label><textarea id="favorite-note" value={note} onChange={event => setNote(event.target.value)} maxLength={10000} rows={4} placeholder="写下你想回来看的原因…" disabled={busy} /><label className="field-label" htmlFor="favorite-time">下次提醒</label><input id="favorite-time" type="datetime-local" value={time} onChange={event => setTime(event.target.value)} disabled={busy} /><p className="field-help">使用当前浏览器的本地时间。修改提醒时间会重新设为待复盘；只改标题或备注会保留原计划。</p>{(validation || error) && <div className="feedback error" role="alert">{validation || error}</div>}<div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? '保存中…' : '保存更改'}</button></div></form></Dialog>;
}
