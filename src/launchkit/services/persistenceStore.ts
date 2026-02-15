/**
 * Persistence Store
 *
 * Lightweight wrapper around PostgresScheduleRepository's KV store.
 * Any service can import `kvSave` / `kvLoad` to persist in-memory state
 * across restarts without needing its own DB setup.
 *
 * Features:
 * - Lazy initialization (first call creates the pool)
 * - Debounced saves to avoid hammering PG on hot paths
 * - Graceful no-op when DATABASE_URL is not set
 */

import { PostgresScheduleRepository } from '../db/postgresScheduleRepository.ts';

let repo: PostgresScheduleRepository | null = null;
let initPromise: Promise<void> | null = null;
let available = false;

/** Initialise (idempotent). Safe to call multiple times. */
async function ensureRepo(): Promise<boolean> {
  if (available) return true;
  if (initPromise) {
    await initPromise;
    return available;
  }
  initPromise = (async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.log('[PersistenceStore] No DATABASE_URL — running without persistence');
      return;
    }
    try {
      repo = await PostgresScheduleRepository.create(dbUrl);
      available = true;
      console.log('[PersistenceStore] ✅ Connected');
    } catch (err) {
      console.error('[PersistenceStore] Failed to connect:', err);
    }
  })();
  await initPromise;
  return available;
}

// ============================================================================
// Core API
// ============================================================================

/** Save a JSON-serialisable value under a key (upsert). Fire-and-forget safe. */
export async function kvSave(key: string, value: unknown): Promise<void> {
  if (!(await ensureRepo()) || !repo) return;
  try {
    await repo.kvSet(key, value);
  } catch (err) {
    console.error(`[PersistenceStore] kvSave(${key}) failed:`, err);
  }
}

/** Load a value by key. Returns null if missing or DB unavailable. */
export async function kvLoad<T = unknown>(key: string): Promise<T | null> {
  if (!(await ensureRepo()) || !repo) return null;
  try {
    return await repo.kvGet<T>(key);
  } catch (err) {
    console.error(`[PersistenceStore] kvLoad(${key}) failed:`, err);
    return null;
  }
}

// ============================================================================
// Debounced Save Helper
// ============================================================================

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced save — batches rapid writes into one DB call.
 * `delayMs` defaults to 5 000 (5 s).
 */
export function kvSaveDebounced(key: string, valueFn: () => unknown, delayMs = 5000): void {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      kvSave(key, valueFn()).catch(() => {});
    }, delayMs)
  );
}

// ============================================================================
// Convenience: Set / Map serialisation helpers
// ============================================================================

/** Persist a Set<string> */
export function saveSet(key: string, set: Set<string>, debounceMs = 5000): void {
  kvSaveDebounced(key, () => [...set], debounceMs);
}

/** Load a Set<string>. Returns empty Set if missing. */
export async function loadSet(key: string): Promise<Set<string>> {
  const arr = await kvLoad<string[]>(key);
  return new Set(arr ?? []);
}

/** Persist a Map<string, V> */
export function saveMap<V>(key: string, map: Map<string, V>, debounceMs = 5000): void {
  kvSaveDebounced(key, () => Object.fromEntries(map), debounceMs);
}

/** Load a Map<string, V>. Returns empty Map if missing. */
export async function loadMap<V>(key: string): Promise<Map<string, V>> {
  const obj = await kvLoad<Record<string, V>>(key);
  if (!obj) return new Map();
  return new Map(Object.entries(obj));
}

/** Persist a plain number / string */
export function saveValue(key: string, value: unknown, debounceMs = 5000): void {
  kvSaveDebounced(key, () => value, debounceMs);
}

/** Load a plain value */
export async function loadValue<T>(key: string): Promise<T | null> {
  return kvLoad<T>(key);
}
