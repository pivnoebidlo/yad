/**
 * Beautifying YAML and JSON files.
 *
 * YAML is re-printed by the `yaml` library (comments, quoting style, block
 * scalars and anchors survive): consistent indentation, single spaces after
 * `:` and `-`, no trailing spaces, at most one blank line in a row.
 * Kubernetes manifests can optionally get well-known keys first (apiVersion,
 * kind, metadata, spec…; name, image… inside containers). Lists are never
 * reordered, and keys of non-Kubernetes documents never move — pipelines
 * keep their meaning.
 *
 * JSON is re-printed by JSON.stringify, and string values that hold a JSON
 * object or array are expanded into real nested values (a log line becomes
 * readable); `expandNestedJson: false` keeps them as strings.
 *
 * Every YAML result is verified: compared strictly with the original (list
 * order matters, nothing ignored) and all comments must still be there. If
 * not, nothing is changed.
 */
import { Lexer, isMap, isSeq, parseAllDocuments, type Node, type Pair } from "yaml";
import { KEY_PRIORITY } from "./config";
import { detectKind } from "./kinds";
import { expandJsonStrings, isJsonText } from "./json";
import { compareTexts } from "./index";

export interface FormatOptions {
  /** Spaces per indentation level. */
  indent: number;
  /** `key:\n  - item` (true) or `key:\n- item` (false). */
  indentSeq: boolean;
  /** Put well-known Kubernetes keys first (other keys keep their order). */
  sortKubernetesKeys: boolean;
  /**
   * JSON only: string values that hold a JSON object or array become real
   * nested values. On by default (undefined counts as on).
   */
  expandNestedJson?: boolean;
}

export const defaultFormatOptions = (): FormatOptions => ({ indent: 2, indentSeq: true, sortKubernetesKeys: true, expandNestedJson: true });

export type FormatResult = { text: string; error?: undefined } | { text?: undefined; error: string };

const rank = (k: string) => {
  const i = KEY_PRIORITY.indexOf(k);
  return i < 0 ? KEY_PRIORITY.length : i;
};
/** Stable: well-known keys first in their order, the rest as they were. */
const sortKeys = <T>(items: T[], key: (x: T) => string) =>
  items.map((x, i) => ({ x, i })).sort((a, b) => rank(key(a.x)) - rank(key(b.x)) || a.i - b.i).map(({ x }) => x);

function sortNode(n: unknown) {
  if (isMap(n)) {
    n.items = sortKeys(n.items as Pair[], (p) => String((p.key as { value?: unknown })?.value ?? p.key));
    for (const p of n.items as Pair[]) sortNode(p.value);
  } else if (isSeq(n)) for (const it of n.items) sortNode(it);
}

function sortJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortJson);
  if (v && typeof v === "object")
    return Object.fromEntries(sortKeys(Object.entries(v as Record<string, unknown>), ([k]) => k).map(([k, x]) => [k, sortJson(x)]));
  return v;
}

/** Comment texts in a YAML text, in order. */
function comments(text: string): string[] {
  const out: string[] = [];
  for (const tok of new Lexer().lex(text)) if (tok.startsWith("#")) out.push(tok.trim());
  return out;
}

const STRICT = { ignore: [], mergeKeys: {}, fallbackMergeKeys: [], emptyEqualsMissing: false };

/** The formatted text, or an error explaining why the file was left alone. */
export function formatText(text: string, opts: FormatOptions = defaultFormatOptions()): FormatResult {
  if (!text.trim()) return { text };

  if (isJsonText(text)) {
    let v: unknown = JSON.parse(text);
    if (opts.expandNestedJson !== false) v = expandJsonStrings(v);
    if (opts.sortKubernetesKeys && detectKind(v) === "kubernetes") v = sortJson(v);
    return { text: JSON.stringify(v, null, opts.indent) + "\n" };
  }

  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs)) return { text };
  const bad = docs.flatMap((d) => d.errors);
  if (bad.length) return { error: bad[0].message.split("\n")[0] };

  for (const doc of docs) {
    if (!(opts.sortKubernetesKeys && doc.contents && detectKind(doc.toJS()) === "kubernetes")) continue;
    // A comment right above the first key is the document's header: keep it
    // at the top instead of letting it travel with that key.
    type Commented = { commentBefore?: string };
    const firstKey = () => (isMap(doc.contents) ? ((doc.contents.items[0] as Pair | undefined)?.key as Commented | undefined) : undefined);
    const header = firstKey()?.commentBefore;
    if (header) firstKey()!.commentBefore = undefined;
    sortNode(doc.contents as Node);
    const k = firstKey();
    if (header && k) k.commentBefore = k.commentBefore ? `${header}\n${k.commentBefore}` : header;
  }
  let out = docs
    .map((d) => d.toString({ indent: opts.indent, indentSeq: opts.indentSeq, lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false }))
    .join("");
  // The library keeps a blank line before an item as one blank line; trim any
  // run of blank lines and trailing spaces it may still produce.
  out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  if (!out.endsWith("\n")) out += "\n";

  // Safety: same content (strictly), same documents, same comments.
  const check = compareTexts(text, out, STRICT);
  if (check.errors.b.length) return { error: `formatted text does not parse: ${check.errors.b[0].message.split("\n")[0]}` };
  const diff = check.resources.find((r) => r.status !== "equal");
  if (diff) return { error: `formatting would change ${diff.label}; nothing was changed` };
  // Comments may move together with their key (sorting), but none may be lost.
  const before = comments(text).sort(), after = comments(out).sort();
  if (before.join("\n") !== after.join("\n")) return { error: "formatting would lose a comment; nothing was changed" };
  return { text: out };
}
