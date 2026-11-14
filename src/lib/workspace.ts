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
}
