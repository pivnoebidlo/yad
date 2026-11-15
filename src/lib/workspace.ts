import { compareTexts, type CompareOptions, type CompareResult, type Touched } from "./semantic";
import { joinPath, type Side } from "./files";

/**
 * In-memory copy of a file; `exists` is false for a file not yet written.
 * `text`/`saved` always use "\n"; the file's own line ending and BOM are
 * remembered and restored on save.
 */
export interface Buf {
  path: string;
  saved: string;
  text: string;
  exists: boolean;
  eol: "\n" | "\r\n";
  bom: boolean;
  /** Disk fingerprint when the file was last read or written (see fileStamps). */
  stamp?: string | null;
}

/** Split a file's content into "\n"-text plus its line ending and BOM. */
export function decodeText(raw: string): { text: string; eol: Buf["eol"]; bom: boolean } {
  const bom = raw.startsWith("\uFEFF");
  const body = bom ? raw.slice(1) : raw;
  return { text: body.replace(/\r\n?/g, "\n"), eol: body.includes("\r\n") ? "\r\n" : "\n", bom };
}

/** File content to write for a buffer. */
export const encodeText = (b: Pick<Buf, "text" | "eol" | "bom">) =>
  (b.bom ? "\uFEFF" : "") + (b.eol === "\n" ? b.text : b.text.replace(/\n/g, b.eol));

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

export function statusOf(e: Entry, result?: CompareResult, options?: Partial<CompareOptions>): FileStatus {
  const a = e.a?.text, b = e.b?.text;
  if (a === undefined && b === undefined) return "equal";
  if (a === undefined) return "added";
  if (b === undefined) return "removed";
  if (a === b) return "equal";
  const r = result ?? compareTexts(a, b, options);
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

/** Smallest single edit turning one text into another (lives in the engine). */
export { minimalEdit } from "./semantic";

/**
 * Store an editor's text in the entry's buffer for `side`. A side without a
 * buffer gets one only when there is text and a directory to create the file
 * in (typing into a file that exists only on the other side).
 */
export function storeEditorText(e: Entry, side: Side, text: string, dirRoot: string | null): void {
  const buf = e[side];
  if (buf) {
    buf.text = text;
    return;
  }
  if (text === "" || dirRoot === null) return;
  const other = e[otherSide(side)];
  e[side] = { path: joinPath(dirRoot, e.rel), saved: "", text, exists: false, eol: other?.eol ?? "\n", bom: other?.bom ?? false };
}

/**
 * What to do when a file changed on disk (`disk` is its new text, null if it
 * is gone):
 *  same      — nothing to do (only touched, or still missing);
 *  reload    — take the disk version (no unsaved edits, or they are identical);
 *  conflict  — unsaved edits differ from the new disk version: ask;
 *  gone      — deleted, no unsaved edits;
 *  goneDirty — deleted while there are unsaved edits (keep them, Save recreates the file).
 */
export type DiskChange = "same" | "reload" | "conflict" | "gone" | "goneDirty";

export function diskChange(buf: Buf, disk: string | null): DiskChange {
  if (disk === null) return !buf.exists ? "same" : isDirty(buf) ? "goneDirty" : "gone";
  if (buf.exists && disk === buf.saved) return "same";
  if (!isDirty(buf) || buf.text === disk) return "reload";
  return "conflict";
}
