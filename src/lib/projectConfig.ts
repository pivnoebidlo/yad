/**
 * `.yad.yaml` — comparison and formatting settings kept in the repository,
 * so the whole team compares and formats manifests the same way. Found by
 * walking up from the compared files (stopping at the repository root); it
 * takes precedence over personal settings for the keys it sets.
 *
 *   ignore:                  # paths ignored in addition to the usual ones
 *     - metadata.labels.team
 *     - spec.replicas
 *   defaultIgnore: true      # false: also compare status, managedFields, uid…
 *   emptyEqualsMissing: true
 *   crossNamespace: true
 *   pairRenamed: true
 *   decodeSecrets: true
 *   format:
 *     indent: 2              # 2 or 4
 *     indentLists: true      # false: "key:\n- item"
 *     sortKubernetesKeys: true
 *     expandNestedJson: true # false: JSON stored in string values stays strings (JSON files)
 */
import { parse } from "yaml";
import { DEFAULT_IGNORE, parsePath, type CompareOptions, type FormatOptions } from "./semantic";

export const CONFIG_NAME = ".yad.yaml";

export interface ProjectConfig {
  ignore?: string[][];
  defaultIgnore?: boolean;
  emptyEqualsMissing?: boolean;
  crossNamespace?: boolean;
  pairRenamed?: boolean;
  decodeSecrets?: boolean;
  format?: Partial<FormatOptions>;
}

const BOOLS = ["defaultIgnore", "emptyEqualsMissing", "crossNamespace", "pairRenamed", "decodeSecrets"] as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse `.yad.yaml`; problems are reported, the valid parts still apply. */
export function parseProjectConfig(text: string): { config: ProjectConfig; errors: string[] } {
  const errors: string[] = [];
  const config: ProjectConfig = {};
  let doc: unknown;
  try {
    doc = parse(text) ?? {};
  } catch (e) {
    return { config, errors: [e instanceof Error ? e.message.split("\n")[0] : String(e)] };
  }
  if (!isObj(doc)) return { config, errors: ["expected a map of settings"] };
  for (const [k, v] of Object.entries(doc)) {
    if (k === "ignore") {
      const list = Array.isArray(v) ? v : [v];
      config.ignore = [];
      for (const p of list) {
        const parsed = typeof p === "string" ? parsePath(p) : null;
        if (parsed) config.ignore.push(parsed);
        else errors.push(`ignore: invalid path ${JSON.stringify(p)}`);
      }
    } else if ((BOOLS as readonly string[]).includes(k)) {
      if (typeof v === "boolean") config[k as (typeof BOOLS)[number]] = v;
      else errors.push(`${k}: expected true or false`);
    } else if (k === "format") {
      if (!isObj(v)) {
        errors.push("format: expected a map");
        continue;
      }
      const f: Partial<FormatOptions> = {};
      for (const [fk, fv] of Object.entries(v)) {
        if (fk === "indent" && (fv === 2 || fv === 4)) f.indent = fv;
        else if (fk === "indentLists" && typeof fv === "boolean") f.indentSeq = fv;
        else if (fk === "sortKubernetesKeys" && typeof fv === "boolean") f.sortKubernetesKeys = fv;
        else if (fk === "expandNestedJson" && typeof fv === "boolean") f.expandNestedJson = fv;
        else errors.push(`format.${fk}: ${["indent", "indentLists", "sortKubernetesKeys", "expandNestedJson"].includes(fk) ? "invalid value" : "unknown setting"}`);
      }
      config.format = f;
    } else errors.push(`${k}: unknown setting`);
  }
  return { config, errors };
}

const same = (p: string[], q: string[]) => p.length === q.length && p.every((s, i) => s === q[i]);

/** Personal comparison options with the project's settings on top. */
export function applyProjectCompare(base: CompareOptions, c: ProjectConfig | null | undefined): CompareOptions {
  if (!c) return base;
  let ignore = base.ignore;
  if (c.defaultIgnore === false) ignore = ignore.filter((p) => !DEFAULT_IGNORE.some((d) => same(d, p)));
  else if (c.defaultIgnore === true) ignore = [...ignore, ...DEFAULT_IGNORE.filter((d) => !ignore.some((p) => same(d, p)))];
  if (c.ignore) ignore = [...ignore, ...c.ignore.filter((p) => !ignore.some((q) => same(p, q)))];
  return {
    ...base,
    ignore,
    emptyEqualsMissing: c.emptyEqualsMissing ?? base.emptyEqualsMissing,
    crossNamespace: c.crossNamespace ?? base.crossNamespace,
    pairRenamed: c.pairRenamed ?? base.pairRenamed,
    decodeSecrets: c.decodeSecrets ?? base.decodeSecrets,
  };
}

export function applyProjectFormat(base: FormatOptions, c: ProjectConfig | null | undefined): FormatOptions {
  return c?.format ? { ...base, ...c.format } : base;
}
