// Deribit option-expiry token helpers, shared between widgets so dropdown
// ordering and saved-profile recovery behave identically. Backend is the
// authoritative source for the token list; these utilities only touch the
// strings the backend already emitted.

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Parse a Deribit expiry token ("26APR26", "8MAY26") to a UTC ms timestamp at
 *  08:00 UTC (Deribit options settlement time). Used for chronological ordering;
 *  the backend treats the token as opaque elsewhere. */
export function parseExpiryMs(token: string): number | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(token);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]];
  if (mon == null) return null;
  return Date.UTC(2000 + Number(m[3]), mon, day, 8, 0, 0);
}

/** Resolve a saved expiry against the currently-listed expiries. If the saved
 *  token is null or no longer in the list (rolled off since the profile was
 *  saved), return the chronologically nearest remaining expiry — preserving
 *  every other widget setting while still giving the user *some* chain. */
export function pickClosestExpiry(saved: string | null | undefined, list: string[]): string | null {
  if (list.length === 0) return null;
  if (!saved) return list[0];
  const savedMs = parseExpiryMs(saved);
  if (savedMs == null) return list[0];
  let best = list[0];
  let bestDiff = Infinity;
  for (const e of list) {
    const ms = parseExpiryMs(e);
    if (ms == null) continue;
    const diff = Math.abs(ms - savedMs);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

/** Sort expiry tokens chronologically (front-month first). Unparseable tokens
 *  fall to the end. */
export function sortExpiries(tokens: Iterable<string>): string[] {
  return [...tokens].sort((a, b) => (parseExpiryMs(a) ?? Infinity) - (parseExpiryMs(b) ?? Infinity));
}
