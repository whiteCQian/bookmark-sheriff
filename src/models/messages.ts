import type { AppState, ReviewStatus, Settings } from './favorite';
import type { BatchChange } from '../services/batch.service';

export type AppRequest =
  | { type: 'GET_STATE' }
  | { type: 'REFRESH_CURRENT_COVER' }
  | { type: 'GET_CAPTURE_SETTINGS' }
  | { type: 'GET_CURRENT_CAPTURE_STATUS' }
  | { type: 'BILIBILI_FAVORITE'; url: string; title: string }
  | { type: 'ZHIHU_FAVORITE'; url: string; title: string }
  | { type: 'X_BOOKMARK'; url: string; postId: string; preview: string; action: 'add' | 'remove' }
  | { type: 'UPDATE_FAVORITE'; id: string; patch: { title?: string; note?: string; reviewAt?: number; status?: ReviewStatus } }
  | { type: 'DELETE_FAVORITE'; id: string }
  | { type: 'BATCH_UPDATE_FAVORITES'; ids: string[]; change: BatchChange }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<Settings> }
  | { type: 'CLEAR_DATA' }
  | { type: 'OPEN_FAVORITE'; id: string };

export type AppResponse<T = AppState> = { ok: true; data: T } | { ok: false; error: string };
