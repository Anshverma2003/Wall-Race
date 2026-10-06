/**
 * Thin, failure-tolerant wrapper around localStorage (private mode or blocked
 * storage must never break the game).
 */
export class StorageService {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
