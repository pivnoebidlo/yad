/// <reference types="node" />
/**
 * yad-cli: the YAD comparison engine without a window, for terminals, CI and git.
 *
 *   yad-cli diff <left> <right>        semantic diff of two files or folders
 *   yad-cli format [--write] <path…>   check (default) or fix formatting
 *   yad-cli git-diff …                 external diff driver for `git diff`
 *
 * Exit codes: 0 — no differences / nothing to format; 1 — differences found /
 * files need formatting; 2 — error (bad arguments, unreadable or invalid files).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  compareTexts, defaultOptions, formatPath, formatText, parsePath,
  type Change, type CompareOptions, type FormatOptions, type ResourceDiff,
} from "../lib/semantic";
import { decodeText, encodeText } from "../lib/textio";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  color: boolean;
}

declare const __YAD_VERSION__: string;
const VERSION = typeof __YAD_VERSION__ === "string" ? __YAD_VERSION__ : "dev";

const HELP = `yad-cli — YAML Ain't Different, in the terminal

Usage:
  yad-cli diff <left> <right> [options]     compare two files or two folders
  yad-cli format [--write] <path>... [opts] check formatting (or fix it with --write)
  yad-cli git-diff <git external diff args> used by git, see below

diff options:
  --output text|markdown|json   report format (default: text)
  --ignore <path>               also ignore this path (repeatable), e.g. metadata.labels.team
  --no-default-ignore           do not ignore status, managedFields, uid, resourceVersion…
  --strict-empty                {} and [] are not the same as a missing key
  --no-cross-namespace          never pair resources from different namespaces
  --order-matters               files that differ only in order/formatting count as different
  -q, --quiet                   no report, only the exit code

format options:
  --write                       rewrite files in place (default: only check)
  --indent 2|4                  spaces per level (default: 2)
  --flush-lists                 "key:\\n- item" instead of "key:\\n  - item"
  --no-sort-k8s                 keep Kubernetes keys in their order

Exit codes: 0 no differences / formatted, 1 differences / needs formatting, 2 error.

Semantic "git diff" for YAML/JSON:
  git config --global diff.yad.command "yad-cli git-diff"
  echo '*.yaml diff=yad' >> .gitattributes   (also *.yml, *.json)
`;

// ---- arguments -----------------------------------------------------------------

type Flags = { pos: string[]; opts: Map<string, string[]> };
const VALUED = new Set(["--output", "--ignore", "--indent"]);

function parseArgs(args: string[]): Flags {
  const pos: string[] = [];
  const opts = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith("-") && a !== "-") {
      const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      const v = VALUED.has(name) ? inline ?? args[++i] : "";
      if (v === undefined) throw new Error(`${name} needs a value`);
      opts.set(name, [...(opts.get(name) ?? []), v]);
    } else pos.push(a);
  }
  return { pos, opts };
}

const KNOWN = {
  diff: ["--output", "--ignore", "--no-default-ignore", "--strict-empty", "--no-cross-namespace", "--order-matters", "-q", "--quiet"],
  format: ["--write", "--indent", "--flush-lists", "--no-sort-k8s", "-q", "--quiet"],
};

function checkKnown(f: Flags, known: string[]) {
  for (const k of f.opts.keys()) if (!known.includes(k)) throw new Error(`unknown option ${k}`);
}

function compareOptions(f: Flags): CompareOptions {
  const o = defaultOptions();
  if (f.opts.has("--no-default-ignore")) o.ignore = [];
  for (const p of f.opts.get("--ignore") ?? []) {
    const parsed = parsePath(p);
    if (!parsed) throw new Error(`invalid path for --ignore: ${p}`);
    o.ignore.push(parsed);
  }
  if (f.opts.has("--strict-empty")) o.emptyEqualsMissing = false;
  if (f.opts.has("--no-cross-namespace")) o.crossNamespace = false;
  return o;
}

// ---- files -----------------------------------------------------------------------

const MANIFEST = /\.(ya?ml|json)$/i;

/** YAML/JSON files under a folder, as "/"-separated relative paths (hidden entries and node_modules skipped). */
export function listManifests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p);
      else if (st?.isFile() && MANIFEST.test(name)) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

const kindOf = (p: string) => {
  const st = statSync(p, { throwIfNoEntry: false });
  return st?.isDirectory() ? "dir" : st ? "file" : "missing";
};
const read = (p: string) => decodeText(readFileSync(p, "utf8"));

// ---- diff ------------------------------------------------------------------------

export type FileStatus = "changed" | "reordered" | "equal" | "added" | "removed" | "error";

export interface FileReport {
  path: string;
  status: FileStatus;
  errors?: string[];
  resources: ResourceDiff[];
}

export function diffTexts(path: string, a: string | null, b: string | null, opts: CompareOptions): FileReport {
  if (a === null && b === null) return { path, status: "equal", resources: [] };
  if (a === null) return { path, status: "added", resources: [] };
  if (b === null) return { path, status: "removed", resources: [] };
  if (a === b) return { path, status: "equal", resources: [] };
  const r = compareTexts(a, b, opts);
  const errors = [...r.errors.a.map((e) => `left: ${e.message.split("\n")[0]}`), ...r.errors.b.map((e) => `right: ${e.message.split("\n")[0]}`)];
  if (errors.length) return { path, status: "error", errors, resources: [] };
  const resources = r.resources.filter((x) => x.status !== "equal");
  return { path, status: resources.length ? "changed" : "reordered", resources };
}

export function diffPaths(left: string, right: string, opts: CompareOptions): FileReport[] {
  const ka = kindOf(left), kb = kindOf(right);
  if (ka === "missing") throw new Error(`${left}: no such file or folder`);
  if (kb === "missing") throw new Error(`${right}: no such file or folder`);
  if (ka !== kb) throw new Error("compare a file with a file, or a folder with a folder");
  if (ka === "file") return [diffTexts(right, read(left).text, read(right).text, opts)];
  const la = new Set(listManifests(left)), lb = new Set(listManifests(right));
  return [...new Set([...la, ...lb])].sort().map((rel) =>
    diffTexts(rel, la.has(rel) ? read(join(left, rel)).text : null, lb.has(rel) ? read(join(right, rel)).text : null, opts),
  );
}

const differs = (r: FileReport, orderMatters: boolean) => r.status !== "equal" && (orderMatters || r.status !== "reordered");

/** Short one-line rendering of a value. */
function show(v: unknown): string {
  if (v === undefined) return "∅";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 70 ? s.slice(0, 67) + "…" : s;
}

function changeLine(c: Change): { path: string; text: string } {
  const path = formatPath(c.path);
  switch (c.kind) {
    case "added": return { path, text: `added ${show(c.b)}` };
    case "removed": return { path, text: `removed ${show(c.a)}` };
    case "moved": return { path, text: `moved from position ${(c.fromIndex ?? 0) + 1}` };
    default: return { path, text: `${show(c.a)} → ${show(c.b)}` };
  }
}

const STATUS_TEXT: Record<FileStatus, string> = {
  changed: "differs", reordered: "order/formatting only", equal: "identical",
  added: "only on the right", removed: "only on the left", error: "cannot be parsed",
};

function summary(reports: FileReport[]) {
  const n = (s: FileStatus) => reports.filter((r) => r.status === s).length;
  const parts = [`${n("changed")} differ`];
  for (const [s, label] of [["added", "only right"], ["removed", "only left"], ["reordered", "order only"], ["error", "invalid"]] as const)
    if (n(s)) parts.push(`${n(s)} ${label}`);
  parts.push(`${n("equal")} identical`);
  return parts.join(", ");
}

export function renderText(reports: FileReport[], io: Pick<Io, "color">, orderMatters = false): string {
  const c = (code: string, s: string) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark = { added: c("32", "+"), removed: c("31", "-"), changed: c("33", "~"), equal: " " };
  const lines: string[] = [];
  for (const r of reports) {
    if (!differs(r, orderMatters) && r.status !== "reordered") continue;
    lines.push(`${c("1", r.path)}: ${STATUS_TEXT[r.status]}`);
    for (const e of r.errors ?? []) lines.push(`  ${c("31", e)}`);
    for (const res of r.resources) {
      const tail = res.status === "added" ? " (only on the right)" : res.status === "removed" ? " (only on the left)" : "";
      lines.push(`  ${mark[res.status]} ${res.label}${tail}`);
      for (const ch of res.changes) {
        const { path, text } = changeLine(ch);
        lines.push(`      ${c("36", path)}: ${text}`);
      }
    }
  }
  if (reports.length > 1 || !lines.length) lines.push((lines.length ? "\n" : "") + summary(reports));
  return lines.join("\n");
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/`/g, "ʼ");

export function renderMarkdown(reports: FileReport[], orderMatters = false): string {
  const out: string[] = [];
  for (const r of reports) {
    if (!differs(r, orderMatters)) continue;
    out.push(`### \`${r.path}\` — ${STATUS_TEXT[r.status]}`, "");
    for (const e of r.errors ?? []) out.push(`- ${md(e)}`);
    for (const res of r.resources) {
      const tail = res.status === "added" ? " — only on the right" : res.status === "removed" ? " — only on the left" : "";
      out.push(`**${md(res.label)}**${tail}`, "");
      if (res.changes.length) {
        out.push("| Path | Left | Right |", "|---|---|---|");
        for (const ch of res.changes) {
          const left = ch.kind === "added" ? "" : ch.kind === "moved" ? `position ${(ch.fromIndex ?? 0) + 1}` : `\`${md(show(ch.a))}\``;
          const right = ch.kind === "removed" ? "" : ch.kind === "moved" ? "moved" : `\`${md(show(ch.b))}\``;
          out.push(`| \`${md(formatPath(ch.path))}\` | ${left} | ${right} |`);
        }
        out.push("");
      }
    }
  }
  out.push(`_${summary(reports)}_`);
  return out.join("\n");
}

export function renderJson(reports: FileReport[]): string {
  return JSON.stringify({
    files: reports.map((r) => ({
      path: r.path,
      status: r.status,
      ...(r.errors ? { errors: r.errors } : {}),
      resources: r.resources.map((res) => ({
        resource: res.label,
        status: res.status,
        changes: res.changes.map((ch) => ({
          path: formatPath(ch.path), kind: ch.kind,
          ...(ch.a !== undefined && ch.kind !== "added" ? { left: ch.a } : {}),
          ...(ch.b !== undefined && ch.kind !== "removed" ? { right: ch.b } : {}),
          ...(ch.kind === "moved" ? { from: (ch.fromIndex ?? 0) + 1 } : {}),
        })),
      })),
    })),
  }, null, 2);
}

function cmdDiff(f: Flags, io: Io): number {
  checkKnown(f, KNOWN.diff);
  if (f.pos.length !== 2) throw new Error("diff needs two paths: yad-cli diff <left> <right>");
  const output = f.opts.get("--output")?.at(-1) ?? "text";
  if (!["text", "markdown", "json"].includes(output)) throw new Error(`unknown --output ${output}`);
  const orderMatters = f.opts.has("--order-matters");
  const reports = diffPaths(f.pos[0], f.pos[1], compareOptions(f));
  if (!f.opts.has("-q") && !f.opts.has("--quiet"))
    io.out(output === "json" ? renderJson(reports) : output === "markdown" ? renderMarkdown(reports, orderMatters) : renderText(reports, io, orderMatters));
  if (reports.some((r) => r.status === "error")) return 2;
  return reports.some((r) => differs(r, orderMatters)) ? 1 : 0;
}

// ---- format ----------------------------------------------------------------------

function cmdFormat(f: Flags, io: Io): number {
  checkKnown(f, KNOWN.format);
  if (!f.pos.length) throw new Error("format needs at least one file or folder");
  const indent = Number(f.opts.get("--indent")?.at(-1) ?? 2);
  if (![2, 4].includes(indent)) throw new Error("--indent must be 2 or 4");
  const opts: FormatOptions = { indent, indentSeq: !f.opts.has("--flush-lists"), sortKubernetesKeys: !f.opts.has("--no-sort-k8s") };
  const write = f.opts.has("--write");
  const quiet = f.opts.has("-q") || f.opts.has("--quiet");

  const files: string[] = [];
  for (const p of f.pos) {
    const k = kindOf(p);
    if (k === "missing") throw new Error(`${p}: no such file or folder`);
    if (k === "dir") files.push(...listManifests(p).map((rel) => join(p, rel)));
    else files.push(p);
  }
  let needs = 0, failed = 0;
  for (const file of files) {
    const buf = read(file);
    const r = formatText(buf.text, opts);
    if (r.error !== undefined) {
      failed++;
      io.err(`${file}: ${r.error}`);
      continue;
    }
    if (r.text === buf.text) continue;
    needs++;
    if (write) writeFileSync(file, encodeText({ ...buf, text: r.text }));
    if (!quiet) io.out(write ? `formatted ${file}` : `needs formatting: ${file}`);
  }
  if (!quiet) {
    const what = write ? `${needs} formatted` : `${needs} need formatting`;
    io.out(`${files.length} files checked, ${what}${failed ? `, ${failed} skipped` : ""}`);
  }
  if (failed) return 2;
  return needs && !write ? 1 : 0;
}

// ---- git -------------------------------------------------------------------------

/**
 * GIT_EXTERNAL_DIFF protocol: `path old-file old-hex old-mode new-file new-hex new-mode`
 * (a deleted or added file is /dev/null), or just `path` for an unmerged file.
 * Must exit 0, otherwise git stops.
 */
function cmdGitDiff(args: string[], io: Io): number {
  if (args.length === 1) {
    io.out(`* Unmerged path ${args[0]}`);
    return 0;
  }
  if (args.length < 7) throw new Error("git-diff is called by git (diff.<driver>.command), not directly");
  const [path, oldFile, , , newFile] = args;
  const text = (p: string) => (p === "/dev/null" ? null : read(p).text);
  const color = io.color || process.env.GIT_PAGER_IN_USE === "true";
  const r = diffTexts(path, text(oldFile), text(newFile), defaultOptions());
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  io.out(c("1", `yad ${path}`) + ` — ${STATUS_TEXT[r.status]}`);
  const body = renderText([r], { color }).split("\n").slice(1).join("\n");
  if (body.trim()) io.out(body);
  return 0;
}

// ---- entry -----------------------------------------------------------------------

export function main(argv: string[], io: Io): number {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "diff": return cmdDiff(parseArgs(rest), io);
      case "format": return cmdFormat(parseArgs(rest), io);
      case "git-diff": return cmdGitDiff(rest, io);
      case "--version": case "-v": io.out(VERSION); return 0;
      case undefined: case "help": case "--help": case "-h": io.out(HELP); return cmd ? 0 : 2;
      default: throw new Error(`unknown command ${cmd}`);
    }
  } catch (e) {
    io.err(`yad-cli: ${e instanceof Error ? e.message : String(e)}`);
    if (cmd !== "git-diff") io.err("Run yad-cli --help for usage.");
    return 2;
  }
}

