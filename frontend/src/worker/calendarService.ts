// calendarService — vol-time calendar (M3.6).
//
// Dual-mode service mediating frontend access to the active vol-time
// calendar. Tabs never hit the FastAPI `/api/calendar` routes directly
// (HRT principle 1) — every write and recalibrate goes through the
// SharedWorker oracle which fans updates out to all open subscriptions.
//
// Surface:
//   * `putCalendar(c)`       — POST + cache-write + fan-out to listeners.
//   * `recalibrate()`        — POST recalibrate; re-emit current calendar
//                              to subscribers as a "calendar changed"
//                              ping (the rev itself doesn't change, but
//                              consumers may want to refit overlays).
//   * `calendarStream()`     — yields current calendar on subscribe + on
//                              every put / recalibrate. Refetches from the
//                              backend on every subscribe so a stale oracle
//                              cache (survives tab reloads and backend
//                              restarts) never trumps the server's view.
//
// Per HRT principle 4, the wire format is plain data (ISO date strings,
// numbers). The frontend never holds a Date object on the dict keys —
// callers convert at the edge with the helpers in shared/volTime.ts.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

// ────────────────────────────────────────────────────────────────────────────
// Wire types
// ────────────────────────────────────────────────────────────────────────────

export interface CalendarPayload {
  /** ISO date string -> day weight in [0, 1] */
  holiday_weights: Record<string, number>;
  /** ISO date string -> human-readable label (cosmetic; not in rev hash) */
  holiday_names: Record<string, string>;
  sat_weight: number;
  sun_weight: number;
  /** SHA-1 hash prefix of the load-bearing fields. Server-computed.
   *  `name` edits do NOT bump this — the user can rename a holiday while
   *  typing without invalidating cached fits. */
  rev: string;
}

export interface RecalibrateResult {
  rev: string;
  /** Number of stale-rev wkg-basis cache entries dropped. Cal-basis entries
   *  don't depend on rev, so they're skipped. Live bucket pumps notice the
   *  rev change on their next chain poll and re-emit a fresh
   *  `*_buckets_snapshot` so subscribers redraw without remount. */
  recalibrated: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Oracle-side state
// ────────────────────────────────────────────────────────────────────────────

interface QueueListener<T = unknown> {
  push: (payload: T) => void;
}

let _cached: CalendarPayload | null = null;
let _inflight: Promise<CalendarPayload> | null = null;
const _streamListeners = new Set<QueueListener<CalendarPayload>>();

async function refetch(): Promise<CalendarPayload> {
  if (_inflight) return _inflight;
  // Coalesce concurrent fetches so a burst of subscribers (many widgets
  // mounting at once) shares one HTTP GET. The first await wins; the
  // rest reuse the promise.
  _inflight = (async () => {
    try {
      const resp = await fetch('/api/calendar');
      if (!resp.ok) throw new Error(`GET /api/calendar: ${resp.status}`);
      const cal = (await resp.json()) as CalendarPayload;
      _cached = cal;
      return cal;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

function emitCalendar(cal: CalendarPayload): void {
  for (const sub of _streamListeners) sub.push(cal);
}

function makeStreamGenerator(): AsyncGenerator<CalendarPayload> {
  const queue: CalendarPayload[] = [];
  let notify: (() => void) | null = null;
  const listener: QueueListener<CalendarPayload> = {
    push: (payload) => {
      queue.push(payload);
      notify?.();
      notify = null;
    },
  };
  _streamListeners.add(listener);

  // Always refetch on subscribe — the SharedWorker's `_cached` survives
  // tab reloads and (more importantly) backend restarts, so serving a
  // stale cache value here means a fresh widget mount can show wildly
  // out-of-date weights. The fetch is cheap (single GET) and coalesced
  // across simultaneous subscribers via `refetch`'s promise dedup.
  refetch().then(cal => listener.push(cal)).catch(() => {});

  async function* gen(): AsyncGenerator<CalendarPayload> {
    try {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else await new Promise<void>((res) => { notify = res; });
      }
    } finally {
      _streamListeners.delete(listener);
    }
  }
  return gen();
}

if (isOracleContext) {
  registerService('calendarPut', async function* (params) {
    const { calendar } = params as { calendar: Omit<CalendarPayload, 'rev'> };
    const resp = await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calendar),
    });
    if (!resp.ok) throw new Error(`POST /api/calendar: ${resp.status}`);
    const updated = (await resp.json()) as CalendarPayload;
    _cached = updated;
    emitCalendar(updated);
    yield updated;
  });

  registerService('calendarRecalibrate', async function* () {
    const resp = await fetch('/api/calendar/recalibrate', { method: 'POST' });
    if (!resp.ok) throw new Error(`POST /api/calendar/recalibrate: ${resp.status}`);
    const result = (await resp.json()) as RecalibrateResult;
    // Re-emit the cached calendar so subscribers refresh any
    // calendar-derived view (frozen overlays etc.) — the calendar object
    // itself didn't change but downstream caches may have.
    if (_cached) emitCalendar(_cached);
    yield result;
  });

  registerService('calendarStream', async function* () {
    yield* makeStreamGenerator();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Client API
// ────────────────────────────────────────────────────────────────────────────

let _putCounter = 0;
let _recalCounter = 0;
let _streamCounter = 0;

async function oneShot<T>(gen: AsyncGenerator<unknown>): Promise<T> {
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('one-shot service yielded no value');
    return value as T;
  } finally {
    await gen.return(undefined).catch(() => {});
  }
}

/** PUT a new calendar. Each call carries a unique `_tag` so the oracle's
 *  refcount-based dedup can't collapse rapid edits (a debounced typing
 *  user firing several puts in quick succession) into a single shared
 *  one-shot generator. */
export function putCalendar(calendar: Omit<CalendarPayload, 'rev'>): Promise<CalendarPayload> {
  const _tag = `${++_putCounter}-${Date.now()}`;
  return oneShot<CalendarPayload>(subscribeRemote('calendarPut', { calendar, _tag }));
}

/** Trigger backend recalibrate. Drops every stale-rev wkg-basis entry
 *  from the per-snapshot fit/TS caches and the M3.9 bucketed caches; the
 *  next chain poll lazily recomputes them under the new rev. Carries a
 *  unique tag so the oracle's refcount-based dedup can't collapse rapid
 *  successive calls. */
export function recalibrate(): Promise<RecalibrateResult> {
  const _tag = `${++_recalCounter}-${Date.now()}`;
  return oneShot<RecalibrateResult>(subscribeRemote('calendarRecalibrate', { _tag }));
}

/** Subscribe to active calendar updates. Yields the current calendar
 *  immediately on subscribe (so a fresh widget mount doesn't wait), then
 *  re-yields on every put / recalibrate. Each call carries a unique tag
 *  so the oracle's refcount-based dedup can't collapse multiple subscribers
 *  into a single shared upstream — the "replay on subscribe" only fires
 *  for the first acquisition under a given key, so late subscribers would
 *  otherwise sit forever on no value until the next change. */
export function calendarStream(): AsyncGenerator<CalendarPayload> {
  const _tag = `${++_streamCounter}-${Date.now()}`;
  return subscribeRemote('calendarStream', { _tag }) as AsyncGenerator<CalendarPayload>;
}
