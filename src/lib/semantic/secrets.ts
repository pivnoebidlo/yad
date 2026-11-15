/**
 * Kubernetes Secrets keep values base64-encoded in `data`, which makes a diff
 * unreadable. These helpers show them decoded (only in memory — files on
 * disk always keep base64) or hide them (command-line reports, CI logs).
 */
import { isMap, isScalar, parseAllDocuments, Scalar, type Pair } from "yaml";
import type { Change, PathSeg, Resource, ResourceDiff } from "./types";
import { keyString } from "./util";

export const isSecret = (r?: Resource) => !!r?.id && r.id.kind === "Secret" && r.id.group === "";
/** Same test by resource key (`group/kind/namespace/name`). */
export const isSecretKey = (key: string) => key.startsWith("/Secret/");

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function encodeBase64Text(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The text a base64 value stands for — only when it is readable UTF-8 text
 * and encodes back to exactly the same string (so editing it is lossless).
 */
export function decodeBase64Text(v: unknown): string | undefined {
  if (typeof v !== "string" || !B64.test(v)) return undefined;
  try {
    const bin = atob(v);
    const text = utf8.decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return undefined;
    return encodeBase64Text(text) === v ? text : undefined;
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const mapValues = (o: Record<string, unknown>, f: (v: unknown) => unknown) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

/** A value at `path` inside a Secret, with `data` values decoded where possible. */
export function decodeSecretValue(path: PathSeg[], v: unknown): unknown {
  const dec = (x: unknown) => decodeBase64Text(x) ?? x;
  if (path[0] !== "data") return path.length === 0 && isObj(v) && isObj(v.data) ? { ...v, data: mapValues(v.data, dec) } : v;
  if (path.length === 1) return isObj(v) ? mapValues(v, dec) : v;
  return path.length === 2 ? dec(v) : v;
}

export const HIDDEN = "(hidden)";
const SECRET_FIELDS = new Set(["data", "stringData"]);

/** A value at `path` inside a Secret, with every secret value replaced by "(hidden)". */
export function hideSecretValue(path: PathSeg[], v: unknown): unknown {
  if (v === undefined) return v;
  if (path.length === 0) {
    if (!isObj(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELDS.has(k) && isObj(x) ? mapValues(x, () => HIDDEN) : x]));
  }
  if (typeof path[0] !== "string" || !SECRET_FIELDS.has(path[0])) return v;
  return path.length === 1 && isObj(v) ? mapValues(v, () => HIDDEN) : HIDDEN;
}

/** Comparison results with Secret values decoded or hidden, for reports. */
export function presentSecrets(resources: ResourceDiff[], how: "decode" | "hide"): ResourceDiff[] {
  const f = how === "decode" ? decodeSecretValue : hideSecretValue;
  return resources.map((r) => {
    if (!isSecret(r.a ?? r.b)) return r;
    const changes: Change[] = r.changes.map((c) => ({
      ...c,
      ...(c.a !== undefined ? { a: f(c.path, c.a) } : {}),
      ...(c.b !== undefined ? { b: f(c.path, c.b) } : {}),
    }));
    return { ...r, changes };
  });
}

/**
 * Turn normalized text (where Secret `data` was shown decoded) back into real
 * values: every `data` value of a Secret is base64-encoded again, except the
 * keys that were shown raw because they are not text (`rawKeys`).
 */
export function encodeSecretsInText(text: string, rawKeys: (resourceKey: string) => Set<string> | undefined): string {
  if (!/kind:\s*Secret\b/.test(text)) return text;
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs) || docs.some((d) => d.errors.length)) return text;
  let changed = false;
  docs.forEach((doc) => {
    const root = doc.contents;
    if (!isMap(root)) return;
    const kind = root.get("kind"), api = root.get("apiVersion");
    if (kind !== "Secret" || api !== "v1") return;
    const data = root.get("data", true);
    if (!isMap(data)) return;
    const meta = root.get("metadata");
    const ns = isMap(meta) ? meta.get("namespace") ?? "" : "", name = isMap(meta) ? meta.get("name") ?? "" : "";
    const raw = rawKeys(`/Secret/${ns}/${name}`) ?? new Set<string>();
    for (const p of data.items as Pair[]) {
      const k = keyString(p);
      if (raw.has(k) || !isScalar(p.value)) continue;
      const v = p.value.value;
      p.value = new Scalar(encodeBase64Text(v == null ? "" : String(v)));
      changed = true;
    }
  });
  return changed ? docs.map((d) => String(d)).join("") : text;
}
