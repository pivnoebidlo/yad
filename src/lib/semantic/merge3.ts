/**
 * Semantic three-way merge (git merge / mergetool): the changes "theirs" made
 * to the common base are carried over to "ours" with the same in-place edits
 * the arrows use, so the result keeps ours' formatting and comments. A
 * change is a conflict only when both sides changed the same key / list item
 * / resource differently — key order, list order and formatting never are.
 */
import { applyEdits } from "./patch";
import { compareTexts, planRevert, type Touched } from "./index";
import { parseResources } from "./resources";
import type { CompareOptions, CompareResult, PathSeg, Resource } from "./types";
import { canonicalString, formatPath, pathOn, toJS } from "./util";

export interface MergeConflict {
  /** Resource key (as in the base, or in the side that added it). */
  key: string;
  label: string;
  /** Path inside the resource; absent when the whole resource conflicts. */
  path?: PathSeg[];
  /** Values at that path; `undefined` means "not there". */
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
}

export interface MergeResult {
  /** Ours with every non-conflicting change of theirs applied (conflicts keep ours). */
  text: string;
  conflicts: MergeConflict[];
  /** How many changes of theirs were applied. */
  applied: number;
  /** Parse errors or changes that could not be applied — the result is not trustworthy. */
  errors: string[];
}

type Touch = Touched & { label: string };

/** Merging must see every field and pair resources only by their exact identity. */
const mergeOptions = (o: Partial<CompareOptions>): Partial<CompareOptions> => ({ ...o, ignore: [], crossNamespace: false, pairRenamed: false });

const segEq = (x: PathSeg, y: PathSeg) =>
  typeof x === "object" && typeof y === "object" ? x.key === y.key && x.value === y.value : x === y;
const isPrefix = (p: PathSeg[], q: PathSeg[]) => p.length <= q.length && p.every((s, i) => segEq(s, q[i]));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Value at `path` in a plain JS tree; `undefined` when it is not there. */
export function valueAt(v: unknown, path: PathSeg[]): unknown {
  for (const seg of path) {
    if (typeof seg === "string") v = isObj(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
    else if (typeof seg === "number") v = Array.isArray(v) ? v[seg] : undefined;
    else v = Array.isArray(v) ? v.find((it) => isObj(it) && String(it[seg.key]) === seg.value) : undefined;
    if (v === undefined) return undefined;
  }
  return v;
}

const same = (x: unknown, y: unknown) =>
  x === undefined || y === undefined ? x === y : canonicalString(x) === canonicalString(y);

/** Identity of a resource across the three texts: its key in the base, else its own. */
const identity = (r: { a?: Resource; b?: Resource }) => (r.a ?? r.b)!.key;

function touches(diff: CompareResult): Touch[] {
  const out: Touch[] = [];
  for (const r of diff.resources) {
    if (r.status === "equal") continue;
    if (!r.a || !r.b) out.push({ key: identity(r), label: r.label });
    else for (const c of r.changes) out.push({ key: identity(r), label: r.label, path: pathOn(c, "b") });
  }
  return out;
}

const overlaps = (x: Touch, y: Touch) =>
  x.key === y.key && (!x.path || !y.path || isPrefix(x.path, y.path) || isPrefix(y.path, x.path));

const jsOf = (r?: Resource) => (r ? toJS(r.node, r.ctx) : undefined);

export function merge3(base: string, ours: string, theirs: string, options: Partial<CompareOptions> = {}): MergeResult {
  const opts = mergeOptions(options);
  const dOurs = compareTexts(base, ours, opts);
  const dTheirs = compareTexts(base, theirs, opts);
  const parseErrors = [
    ...dOurs.errors.a.map((e) => `base, line ${e.line}: ${e.message}`),
    ...dOurs.errors.b.map((e) => `ours, line ${e.line}: ${e.message}`),
    ...dTheirs.errors.b.map((e) => `theirs, line ${e.line}: ${e.message}`),
  ];
  if (parseErrors.length) return { text: ours, conflicts: [], applied: 0, errors: parseErrors };

  const O = new Map(dOurs.resources.map((r) => [identity(r), r]));
  const T = new Map(dTheirs.resources.map((r) => [identity(r), r]));
  const values = (key: string, path: PathSeg[] = []) => {
    const at = (r?: Resource) => (r ? valueAt(jsOf(r), path) : undefined);
    return { base: at(O.get(key)?.a ?? T.get(key)?.a), ours: at(O.get(key)?.b), theirs: at(T.get(key)?.b) };
  };

  const oursTouched = touches(dOurs);
  const toApply: Touch[] = [];
  const conflicts: MergeConflict[] = [];
  const seen = new Set<string>();
  for (const t of touches(dTheirs)) {
    const clash = oursTouched.filter((o) => overlaps(o, t));
    if (!clash.length) {
      toApply.push(t);
      continue;
    }
    // Judge the conflict at the widest of the overlapping paths.
    let path = t.path;
    for (const o of clash) if (path && (!o.path || o.path.length < path.length)) path = o.path;
    const v = values(t.key, path);
    if (same(v.ours, v.theirs)) continue; // both sides made the same change
    const id = `${t.key}|${path ? JSON.stringify(path) : ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    conflicts.push({ key: t.key, label: t.label, path, ...v });
  }

  let text = ours;
  const errors: string[] = [];
  if (toApply.length) {
    const plan = planRevert(theirs, ours, toApply, opts);
    errors.push(...plan.errors);
    text = applyEdits(ours, plan.edits);
    errors.push(...verify(text, toApply, (t) => values(t.key, t.path).theirs));
  }
  return { text, conflicts, applied: toApply.length, errors };
}

/** Every applied change must now read as in theirs; anything else is reported. */
function verify(text: string, applied: Touch[], expected: (t: Touch) => unknown): string[] {
  const parsed = parseResources(text);
  if (parsed.errors.length) return [`merged text does not parse: line ${parsed.errors[0].line}: ${parsed.errors[0].message}`];
  const byKey = new Map(parsed.resources.map((r) => [r.key, r]));
  return applied
    .filter((t) => !same(valueAt(jsOf(byKey.get(t.key)), t.path ?? []), expected(t)))
    .map((t) => `${t.label}${t.path ? " " + formatPath(t.path) : ""}: could not apply the change from theirs`);
}

/**
 * Resolve one conflict in the merged `text` by taking the value from `source`
 * (the ours or theirs text). Returns the new text, or an error.
 */
export function resolveConflict(
  text: string, source: string, c: MergeConflict, options: Partial<CompareOptions> = {},
): { text: string; errors: string[] } {
  const plan = planRevert(source, text, [{ key: c.key, path: c.path }], mergeOptions(options));
  return { text: applyEdits(text, plan.edits), errors: plan.errors };
}
