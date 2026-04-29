export const DEFAULT_PROFILE = 'default';

const PROFILES_KEY = 'deribit-smile:profiles';
const ACTIVE_KEY = 'deribit-smile:active-profile';
const layoutKey = (name: string) => `deribit-smile:layout:${name}`;

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function listProfiles(): string[] {
  const raw = readJSON<unknown>(PROFILES_KEY, []);
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
}

export function saveLayout(name: string, layout: unknown): void {
  writeJSON(layoutKey(name), layout);
  const profiles = listProfiles();
  if (!profiles.includes(name)) {
    profiles.push(name);
    writeJSON(PROFILES_KEY, profiles);
  }
}

export function loadLayout(name: string): unknown {
  return readJSON<unknown>(layoutKey(name), null);
}

export function deleteProfile(name: string): void {
  localStorage.removeItem(layoutKey(name));
  writeJSON(PROFILES_KEY, listProfiles().filter(p => p !== name));
}

export function getActiveProfile(): string {
  return localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_PROFILE;
}

export function setActiveProfile(name: string): void {
  localStorage.setItem(ACTIVE_KEY, name);
}

// ---------- JSON import / export ----------

export interface ProfileBundle {
  version: 1;
  active: string;
  profiles: Record<string, unknown>;
}

export function exportAllProfiles(): ProfileBundle {
  const profiles: Record<string, unknown> = {};
  for (const name of listProfiles()) {
    const layout = loadLayout(name);
    if (layout) profiles[name] = layout;
  }
  return { version: 1, active: getActiveProfile(), profiles };
}

export function importProfiles(bundle: unknown): { imported: string[]; active: string | null } {
  if (!bundle || typeof bundle !== 'object') throw new Error('invalid bundle');
  const b = bundle as Partial<ProfileBundle>;
  if (b.version !== 1 || !b.profiles || typeof b.profiles !== 'object') {
    throw new Error('unsupported bundle version');
  }
  const imported: string[] = [];
  for (const [name, layout] of Object.entries(b.profiles)) {
    if (typeof name !== 'string' || name.length === 0) continue;
    saveLayout(name, layout);
    imported.push(name);
  }
  const active = typeof b.active === 'string' && imported.includes(b.active) ? b.active : null;
  if (active) setActiveProfile(active);
  return { imported, active };
}
