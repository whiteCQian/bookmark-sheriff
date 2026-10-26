import { DEFAULT_SETTINGS, type AppState } from '../models/favorite';
import { normalizeStoredState, type RecordValidationCache } from './storage-validation';

export const STORAGE_KEY = 'bookmind.state.v1';
export interface StoragePort {
  read(): Promise<unknown>;
  write(state: AppState): Promise<void>;
}

export function emptyState(): AppState {
  return { schemaVersion: 1, favorites: [], settings: { ...DEFAULT_SETTINGS }, diagnostics: [] };
}

export class StorageService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly recordValidationCache: RecordValidationCache = new Map();
  constructor(private readonly port: StoragePort) {}

  private async read(): Promise<{ state: AppState; before: string }> {
    const raw = await this.port.read();
    const original = raw === undefined ? emptyState() : raw;
    return { state: normalizeStoredState(original, this.recordValidationCache), before: JSON.stringify(original) };
  }

  snapshot(): Promise<AppState> {
    const task = this.queue.then(async () => (await this.read()).state);
    this.queue = task.catch(() => undefined);
    return task;
  }

  transaction<T>(mutate: (state: AppState) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const { state, before } = await this.read();
      const result = await mutate(state);
      // Comparisons include read repairs, so a legacy key or quarantined entry
      // is saved once; ordinary no-op transactions never rewrite the database.
      if (JSON.stringify(state) !== before) await this.port.write(state);
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  report(message: string): Promise<void> {
    return this.transaction(state => {
      state.diagnostics = [{ at: Date.now(), message: message.slice(0, 500) }, ...state.diagnostics].slice(0, 10);
    });
  }
}

export function chromeStoragePort(): StoragePort {
  return {
    read: async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY],
    write: state => chrome.storage.local.set({ [STORAGE_KEY]: state }),
  };
}
