/**
 * Open tabs (to reopen them on the next start) and recently compared pairs,
 * kept in the webview's localStorage. Only paths are stored — never file
 * contents or unsaved edits.
 */

export type RenderTool = "kustomize" | "helm";
/** What one side of a comparison shows: a file, a folder, or a rendered Kustomize/Helm folder. */
export type Source = { kind: "file" | "dir" | "render"; path: string; tool?: RenderTool; values?: string[] };
export type Pair = { a: Source | null; b: Source | null };
export type Recent = { a: Source; b: Source; at: number };
/** A comparison saved under a name. Paths only — never file contents. */
export type Favorite = { name: string; a: Source; b: Source };

const SESSION_KEY = "yad.session";
const RECENT_KEY = "yad.recent";
const FAVORITES_KEY = "yad.favorites";
const MAX_RECENT = 20;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

const isSource = (s: unknown): s is Source =>
  !!s && typeof s === "object" && typeof (s as Source).path === "string" && ["file", "dir", "render"].includes((s as Source).kind);
const cleanPair = (p: Pair): Pair => ({ a: isSource(p?.a) ? p.a : null, b: isSource(p?.b) ? p.b : null });

export function loadSession(): { tabs: Pair[]; active: number } | null {
  const s = read<{ tabs: Pair[]; active: number }>(SESSION_KEY);
  if (!s || !Array.isArray(s.tabs)) return null;
  const tabs = s.tabs.map(cleanPair).filter((p) => p.a || p.b);
  return tabs.length ? { tabs, active: Math.max(0, Math.min(Number(s.active) || 0, tabs.length - 1)) } : null;
}

export function saveSession(tabs: Pair[], active: number) {
  write(SESSION_KEY, { tabs: tabs.map(cleanPair), active });
}

const sameSource = (x: Source, y: Source) =>
  x.kind === y.kind && x.path === y.path && x.tool === y.tool && (x.values ?? []).join("\n") === (y.values ?? []).join("\n");

export function loadRecent(): Recent[] {
  const r = read<Recent[]>(RECENT_KEY);
  return Array.isArray(r) ? r.filter((x) => isSource(x?.a) && isSource(x?.b)) : [];
}

/** Put a compared pair first (once), keeping the list short. */
export function addRecent(list: Recent[], a: Source, b: Source, now = Date.now()): Recent[] {
  const rest = list.filter((r) => !(sameSource(r.a, a) && sameSource(r.b, b)));
  const next = [{ a, b, at: now }, ...rest].slice(0, MAX_RECENT);
  write(RECENT_KEY, next);
  return next;
}

export function removeRecent(list: Recent[], item: Recent): Recent[] {
  const next = list.filter((r) => r !== item);
  write(RECENT_KEY, next);
  return next;
}

export function clearRecent(): Recent[] {
  write(RECENT_KEY, []);
  return [];
}

// ---- favorites ---------------------------------------------------------------

export function loadFavorites(): Favorite[] {
  const v = read<Favorite[]>(FAVORITES_KEY);
  return Array.isArray(v) ? v.filter((x) => typeof x?.name === "string" && x.name && isSource(x?.a) && isSource(x?.b)) : [];
}

/** Save a pair as a favorite; saving the same pair again renames the entry. */
export function addFavorite(list: Favorite[], item: Favorite): Favorite[] {
  const next = [{ ...item }, ...list.filter((f) => !(sameSource(f.a, item.a) && sameSource(f.b, item.b)))];
  write(FAVORITES_KEY, next);
  return next;
}

export function removeFavorite(list: Favorite[], item: Favorite): Favorite[] {
  const next = list.filter((f) => f !== item);
  write(FAVORITES_KEY, next);
  return next;
}

const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const parent = (p: string) => base(p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, ""));

/** "stage ↔ prod", "deployment.yaml (stage ↔ prod)" when the names are the same. */
export function pairTitle(a: Source | null, b: Source | null, empty: string): string {
  if (!a && !b) return empty;
  if (!a || !b) return base((a ?? b)!.path);
  const [x, y] = [base(a.path), base(b.path)];
  if (x !== y) return `${x} ↔ ${y}`;
  const [px, py] = [parent(a.path), parent(b.path)];
  return px && py && px !== py ? `${x} (${px} ↔ ${py})` : x;
}
