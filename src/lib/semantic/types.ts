import type { Document, LineCounter, Node } from "yaml";
import type { DocKind } from "./kinds";

/** One step in a path: map key, list index, or keyed list item (`containers[name=web]`). */
export type PathSeg = string | number | { key: string; value: string };

/** Location in the original text. `from`/`to` are offsets, `line` is 1-based. */
export interface SourceRange {
  from: number;
  to: number;
  line: number;
}

/** `moved`: the same list item sits at another position (order matters in that list). */
export type ChangeKind = "added" | "removed" | "changed" | "moved";

export interface Change {
  path: PathSeg[];
  kind: ChangeKind;
  /** Value on the left (absent for `added`). */
  a?: unknown;
  /** Value on the right (absent for `removed`). */
  b?: unknown;
  aRange?: SourceRange;
  bRange?: SourceRange;
  /** For `moved`: index of the item on the left; the path ends with its index on the right. */
  fromIndex?: number;
  /**
   * Path on the left / right side when it differs from `path` (inside unkeyed
   * lists an item can have different indexes). Use `pathOn()`.
   */
  aPath?: PathSeg[];
  bPath?: PathSeg[];
}

export interface ResourceId {
  apiVersion: string;
  /** API group without version; "" for the core group. */
  group: string;
  kind: string;
  /** "" when not set (cluster-scoped or omitted). */
  namespace: string;
  name: string;
}

/** Parsed document plus what is needed to resolve aliases and positions. */
export interface SourceCtx {
  doc: Document.Parsed;
  lc: LineCounter;
  /** The full source text the document was parsed from. */
  text: string;
}

export interface Resource {
  /** Matching key: `group/kind/namespace/name`, or `#<n>` for non-k8s documents. */
  key: string;
  id: ResourceId | null;
  /** What the document is (Kubernetes, a pipeline, …); decides the comparison rules. */
  docKind: DocKind;
  label: string;
  node: Node;
  range: SourceRange;
  ctx: SourceCtx;
}

export type ResourceStatus = "added" | "removed" | "changed" | "equal";

export interface ResourceDiff {
  key: string;
  label: string;
  status: ResourceStatus;
  a?: Resource;
  b?: Resource;
  changes: Change[];
}

export interface ParseError {
  message: string;
  line: number;
}

export interface CompareResult {
  resources: ResourceDiff[];
  errors: { a: ParseError[]; b: ParseError[] };
}

export interface CompareOptions {
  /**
   * Paths (relative to a k8s resource root) to skip. Each pattern is a list of
   * segments; `*` matches any single segment. Only applied to k8s resources.
   */
  ignore: string[][];
  /** List field name → candidate item keys used to match list items regardless of order. */
  mergeKeys: Record<string, string[]>;
  /** Candidate keys tried for lists not in `mergeKeys`. */
  fallbackMergeKeys: string[];
  /**
   * Treat an empty map/list (after ignores) the same as a missing key, like
   * k8s `omitempty`: `annotations: {}` equals no annotations.
   */
  emptyEqualsMissing: boolean;
}
