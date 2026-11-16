/**
 * Split a diff chunk of the semantic view into independently appliable parts.
 *
 * Keys in the normalized view are sorted, so unrelated changes often land on
 * adjacent lines and the diff merges them into one chunk (e.g. a changed
 * `resources.requests` followed by a removed `secretMounts`). One arrow for
 * the whole chunk would apply all of them; instead each run of changes with a
 * common parent gets its own arrow.
 */
import type { Side } from "./files";

export interface PartItem<T> {
  item: T;
  /** Changes with the same group (parent path) that follow each other share an arrow. */
  group: string;
  /** Line of the change relative to the chunk start, on each side it exists on. */
  a?: number;
  b?: number;
}

export interface Part<T> {
  items: T[];
  /** Where to draw the arrow: a line (relative to the chunk start) on a side. */
  side: Side;
  line: number;
}

export function splitChunk<T>(items: PartItem<T>[]): Part<T>[] {
  // Anchor every change at its lowest line, so a change that sits below
  // something else on one side does not share the row with it.
  const anchored = items
    .map((it, i) => {
      const side: Side = it.a === undefined || (it.b !== undefined && it.b >= it.a) ? "b" : "a";
      return { it, i, side, line: (side === "a" ? it.a : it.b) ?? 0 };
    })
    .sort((x, y) => x.line - y.line || x.i - y.i);

  const parts: (Part<T> & { group: string })[] = [];
  for (const { it, side, line } of anchored) {
    const last = parts[parts.length - 1];
    // Same parent as the previous change, or no room for another arrow on this row.
    if (last && (last.group === it.group || last.line === line)) {
      last.items.push(it.item);
      last.group = it.group;
      continue;
    }
    parts.push({ items: [it.item], side, line, group: it.group });
  }
  return parts.map(({ items, side, line }) => ({ items, side, line }));
}

/** Sorted line start offsets of a text, for line lookups by binary search. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 0-based line number of `pos`. */
export function lineOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Copy a chunk's lines from `src` over the matching lines of `dst` (offsets
 * as in a merge view chunk: `to` may point one past the end of the text).
 */
export function copyChunkText(src: string, srcFrom: number, srcTo: number, dst: string, dstFrom: number, dstTo: number): string {
  let insert = src.slice(srcFrom, Math.max(srcFrom, srcTo - 1));
  if (srcFrom !== srcTo && dstTo <= dst.length) insert += "\n";
  return dst.slice(0, dstFrom) + insert + dst.slice(Math.min(dst.length, dstTo));
}
