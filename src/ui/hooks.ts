import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, FavoriteRecord } from '../models/favorite';
import type { AppRequest } from '../models/messages';
import { STORAGE_KEY } from '../services/storage.service';
import { errorMessage, request } from './api';
import { endOfToday } from './format';

export function useAppState() {
  const [state, setState] = useState<AppState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(false);
  const version = useRef(0);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const refresh = useCallback((): Promise<void> => {
    if (!active.current) return Promise.resolve();
    version.current++;
    if (inFlight.current) return inFlight.current;

    const drain = async () => {
      // Batch the action acknowledgement and storage notifications in the same turn.
      await Promise.resolve();
      while (active.current) {
        const current = version.current;
        try {
          const data = await request<AppState>({ type: 'GET_STATE' });
          if (active.current && current === version.current) {
            setState(data);
            setError('');
          }
        } catch (cause) {
          if (active.current && current === version.current) setError(errorMessage(cause));
        }
        if (current === version.current) {
          if (active.current) setLoading(false);
          break;
        }
        // A mutation arrived during this read. Discard its stale response and
        // perform one follow-up read for every invalidation accumulated so far.
      }
      // Release before resolving this async function. A mutation acknowledgement
      // can run between its completion and Promise.finally, and must start a new
      // read instead of attaching to a drain that has already finished.
      inFlight.current = undefined;
    };
    inFlight.current = drain();
    return inFlight.current;
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Object.hasOwn(changes, STORAGE_KEY)) void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { active.current = false; version.current++; chrome.storage.onChanged.removeListener(changed); };
  }, [refresh]);
  return { state, loading, error, refresh };
}

/** Update local time only at a reminder/day boundary or when the page is revisited. */
export function useReviewClock(favorites: readonly FavoriteRecord[] = []) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => { setNow(Date.now()); };
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    const next = favorites.reduce((at, item) => (
      item.status === 'pending' && item.reviewAt >= now ? Math.min(at, item.reviewAt + 1) : at
    ), endOfToday(now) + 1);
    const timer = window.setTimeout(update, Math.max(1, next - Date.now()));
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [favorites, now]);
  return now;
}

export function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (message: AppRequest, success = ''): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(message);
      if (message.type !== 'OPEN_FAVORITE') await refresh();
      if (active.current) setNotice(success);
      return true;
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
      return false;
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { busy, error, notice, run, clearFeedback: () => { setError(''); setNotice(''); } };
}
