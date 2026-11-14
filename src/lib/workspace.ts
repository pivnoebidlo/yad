import { compareTexts, type CompareResult, type Touched } from "./semantic";
import type { Side } from "./files";

/** In-memory copy of a file; `exists` is false for a file not yet written. */
export interface Buf {
  path: string;
  saved: string;
  text: string;
  exists: boolean;
}

/**
 * changed — semantic differences; reordered — same content, different text;
 * added/removed — only on the right/left; error — a side does not parse.
 */
export type FileStatus = "changed" | "reordered" | "equal" | "added" | "removed" | "error";

export interface Entry {
  /** Relative path in directory mode, "" when comparing two files. */
  rel: string;
  a?: Buf;
  b?: Buf;
  status: FileStatus;
}

export const isDirty = (b?: Buf) => !!b && (b.text !== b.saved || (!b.exists && b.text !== ""));

export function statusOf(e: Entry, result?: CompareResult): FileStatus {
  const a = e.a?.text, b = e.b?.text;
  if (a === undefined && b === undefined) return "equal";
  if (a === undefined) return "added";
  if (b === undefined) return "removed";
  if (a === b) return "equal";
  const r = result ?? compareTexts(a, b);
  if (r.errors.a.length || r.errors.b.length) return "error";
  return r.resources.some((x) => x.status !== "equal") ? "changed" : "reordered";
}

export const otherSide = (s: Side): Side => (s === "a" ? "b" : "a");

/** One apply (arrow click), kept so it can be undone selectively later. */
export interface Op {
  id: number;
  /** Entry the apply happened in (relative path, "" for two files). */
  rel: string;
  /** Side whose text was changed. */
  side: Side;
  label: string;
  /** Target text right before the apply; null if the file did not exist. */
  before: string | null;
  /** Target text right after it. */
  after: string;
  /** Semantic paths touched; absent for plain text block copies. */
  touched?: Touched[];
  /** Text copies: where the copied block starts in the target, kept up to date. */
  anchor?: number;
}

/** An "undo" button shown in the arrow column at the line of `pos` on `side`. */
export interface Marker {
  id: number;
  side: Side;
  pos: number;
  title: string;
}

/** Smallest single edit turning `from` into `to` (common prefix/suffix kept). */
export function minimalEdit(from: string, to: string) {
  let p = 0;
  const max = Math.min(from.length, to.length);
  while (p < max && from[p] === to[p]) p++;
  let s = 0;
  while (s < max - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
  return { from: p, to: from.length - s, insert: to.slice(p, to.length - s) };
}
