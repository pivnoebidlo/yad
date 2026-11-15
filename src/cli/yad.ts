/// <reference types="node" />
/**
 * yad-cli: the YAD comparison engine without a window, for terminals, CI and git.
 *
 *   yad-cli diff <left> <right>        semantic diff of two files or folders
 *   yad-cli format [--write] <path…>   check (default) or fix formatting
 *   yad-cli git-diff …                 external diff driver for `git diff`
 *   yad-cli merge <base> <ours> <theirs>  semantic three-way merge
 *   yad-cli merge-driver …             merge driver for `git merge` / `rebase`
 *
 * Exit codes: 0 — no differences / nothing to format; 1 — differences found /
 * files need formatting; 2 — error (bad arguments, unreadable or invalid files).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_IGNORE, isMultiline, lineDiff, summarizeTextChange, compareTexts, decodeSecretValue, defaultOptions, formatPath, formatText, hideSecretValue, isSecretKey, merge3, parsePath, presentSecrets, resolveConflict,
  type Change, type MergeConflict, type CompareOptions, type FormatOptions, type ResourceDiff,
} from "../lib/semantic";
import { decodeText, encodeText } from "../lib/textio";
import { CONFIG_NAME, applyProjectCompare, applyProjectFormat, parseProjectConfig, type ProjectConfig } from "../lib/projectConfig";

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
  yad-cli merge <base> <ours> <theirs> [options]
                                            three-way merge of two edits of one file
  yad-cli git-diff <git external diff args> used by git, see below
  yad-cli merge-driver %O %A %B %P [%L]     used by git, see below

diff options:
  --output text|markdown|json   report format (default: text)
  --ignore <path>               also ignore this path (repeatable), e.g. metadata.labels.team
  --no-default-ignore           do not ignore status, managedFields, uid, resourceVersion…
  --strict-empty                {} and [] are not the same as a missing key
  --no-cross-namespace          never pair resources from different namespaces
  --no-pair-renamed             never pair resources with different names (elk-stage / elk-prod)
  --order-matters               files that differ only in order/formatting count as different
  --show-secrets                show Secret values decoded (default: hidden, safe for CI logs)
  --no-config                   do not read .yad.yaml (diff, format, merge)
  -q, --quiet                   no report, only the exit code

format options:
  --write                       rewrite files in place (default: only check)
  --indent 2|4                  spaces per level (default: 2)
  --flush-lists                 "key:\\n- item" instead of "key:\\n  - item"
  --no-sort-k8s                 keep Kubernetes keys in their order

merge options:
  -o, --out <file>              write the result there (default: standard output)
  --prefer ours|theirs          settle conflicts with that side (default: report them, write nothing)
  --show-secrets                show Secret values in conflict reports (default: hidden)
  The result keeps the formatting and comments of <ours>.

Project settings: a .yad.yaml in the compared folder or above (up to the
repository root) sets ignored paths and formatting for everyone; flags win.

Exit codes: 0 no differences / formatted / merged, 1 differences / needs
formatting / conflicts, 2 error.

Semantic "git diff" for YAML/JSON:
  git config --global diff.yad.command "yad-cli git-diff"   (add --show-secrets to see Secret values)
  echo '*.yaml diff=yad' >> .gitattributes   (also *.yml, *.json)

Semantic merges in "git merge" / "git rebase" (conflicts fall back to git's markers):
  git config --global merge.yad.driver "yad-cli merge-driver %O %A %B %P %L"
  echo '*.yaml merge=yad' >> .gitattributes
`;

// ---- arguments -----------------------------------------------------------------

type Flags = { pos: string[]; opts: Map<string, string[]> };
const VALUED = new Set(["--output", "--ignore", "--indent", "-o", "--out", "--prefer"]);

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
  diff: ["--output", "--ignore", "--no-default-ignore", "--strict-empty", "--no-cross-namespace", "--no-pair-renamed", "--order-matters", "--show-secrets", "--no-config", "-q", "--quiet"],
  merge: ["-o", "--out", "--prefer", "--show-secrets", "--no-config", "-q", "--quiet"],
  format: ["--no-config", "--write", "--indent", "--flush-lists", "--no-sort-k8s", "-q", "--quiet"],
};

function checkKnown(f: Flags, known: string[]) {
  for (const k of f.opts.keys()) if (!known.includes(k)) throw new Error(`unknown option ${k}`);
}

/** Defaults, then the project's .yad.yaml, then explicit flags. */
function compareOptions(f: Flags, cfg: ProjectConfig | null = null): CompareOptions {
  const o = applyProjectCompare(defaultOptions(), cfg);
  if (f.opts.has("--no-default-ignore")) o.ignore = o.ignore.filter((p) => !DEFAULT_IGNORE.some((d) => d.join("\0") === p.join("\0")));
  for (const p of f.opts.get("--ignore") ?? []) {
    const parsed = parsePath(p);
    if (!parsed) throw new Error(`invalid path for --ignore: ${p}`);
    o.ignore.push(parsed);
  }
  if (f.opts.has("--strict-empty")) o.emptyEqualsMissing = false;
  if (f.opts.has("--no-cross-namespace")) o.crossNamespace = false;
  if (f.opts.has("--no-pair-renamed")) o.pairRenamed = false;
  return o;
}

/**
 * The .yad.yaml that applies to `start`: in its folder or above, up to the
 * repository root. Invalid settings are an error (exit 2) unless `lenient`
 * (git drivers must not fail on them; they only warn).
 */
export function findProjectConfig(start: string, io: Io, lenient = false): ProjectConfig | null {
  let dir = resolve(start);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) dir = dirname(dir);
  for (;;) {
    const file = join(dir, CONFIG_NAME);
    if (existsSync(file) && statSync(file).isFile()) {
      const { config, errors } = parseProjectConfig(readFileSync(file, "utf8"));
      if (errors.length && !lenient) throw new Error(`${file}: ${errors.join("; ")}`);
      errors.forEach((e) => io.err(`yad: ${file}: ${e}`));
      return config;
    }
    if (existsSync(join(dir, ".git"))) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const configFor = (f: Flags, start: string, io: Io) => (f.opts.has("--no-config") ? null : findProjectConfig(start, io));

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
  /** Problems that did not stop the comparison (repeated keys). */
  warnings?: string[];
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
  const warnings = [...r.warnings.a.map((e) => `left, line ${e.line}: ${e.message}`), ...r.warnings.b.map((e) => `right, line ${e.line}: ${e.message}`)];
  return { path, status: resources.length ? "changed" : "reordered", resources, ...(warnings.length ? { warnings } : {}) };
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

/** Secret values in reports: hidden unless asked for (reports end up in CI logs). */
const withSecrets = (reports: FileReport[], show: boolean): FileReport[] =>
  reports.map((r) => ({ ...r, resources: presentSecrets(r.resources, show ? "decode" : "hide") }));

const differs = (r: FileReport, orderMatters: boolean) => r.status !== "equal" && (orderMatters || r.status !== "reordered");

/** Short one-line rendering of a value. */
function show(v: unknown): string {
  if (v === undefined) return "∅";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 70 ? s.slice(0, 67) + "…" : s;
}

function changeLine(c: Change): { path: string; text: string; detail?: string[] } {
  const path = formatPath(c.path);
  // Embedded configs and scripts: the changed lines, not two truncated copies.
  if (c.kind === "changed" && (isMultiline(c.a) || isMultiline(c.b)) && typeof c.a === "string" && typeof c.b === "string") {
    const d = lineDiff(c.a, c.b);
    const detail = d.slice(0, 40).map((l) => `${l.op} ${String(l.line).padStart(4)}| ${l.text}`);
    if (d.length > 40) detail.push(`… ${d.length - 40} more`);
    return { path, text: `text changed (${d.length} line${d.length === 1 ? "" : "s"})`, detail };
  }
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
    if (!differs(r, orderMatters) && r.status !== "reordered" && !r.warnings) continue;
    lines.push(`${c("1", r.path)}: ${STATUS_TEXT[r.status]}`);
    for (const e of r.errors ?? []) lines.push(`  ${c("31", e)}`);
    for (const w of r.warnings ?? []) lines.push(`  ${c("33", "warning: " + w)}`);
    for (const res of r.resources) {
      const tail = res.status === "added" ? " (only on the right)" : res.status === "removed" ? " (only on the left)" : "";
      lines.push(`  ${mark[res.status]} ${res.label}${tail}`);
      for (const ch of res.changes) {
        const { path, text, detail } = changeLine(ch);
        lines.push(`      ${c("36", path)}: ${text}`);
        for (const d of detail ?? []) lines.push(`          ${c(d.startsWith("-") ? "31" : d.startsWith("+") ? "32" : "2", d)}`);
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
    for (const w of r.warnings ?? []) out.push(`- ⚠️ ${md(w)}`);
    for (const res of r.resources) {
      const tail = res.status === "added" ? " — only on the right" : res.status === "removed" ? " — only on the left" : "";
      out.push(`**${md(res.label)}**${tail}`, "");
      if (res.changes.length) {
        out.push("| Path | Left | Right |", "|---|---|---|");
        for (const ch of res.changes) {
          if (ch.kind === "changed" && typeof ch.a === "string" && typeof ch.b === "string" && (isMultiline(ch.a) || isMultiline(ch.b))) {
            out.push(`| \`${md(formatPath(ch.path))}\` | text | ${md(summarizeTextChange(ch.a, ch.b, (s) => (s.length > 60 ? s.slice(0, 57) + "…" : s)))} |`);
            continue;
          }
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
      ...(r.warnings ? { warnings: r.warnings } : {}),
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
  const reports = withSecrets(diffPaths(f.pos[0], f.pos[1], compareOptions(f, configFor(f, f.pos[0], io))), f.opts.has("--show-secrets"));
  if (!f.opts.has("-q") && !f.opts.has("--quiet"))
    io.out(output === "json" ? renderJson(reports) : output === "markdown" ? renderMarkdown(reports, orderMatters) : renderText(reports, io, orderMatters));
  if (reports.some((r) => r.status === "error")) return 2;
  return reports.some((r) => differs(r, orderMatters)) ? 1 : 0;
}

// ---- format ----------------------------------------------------------------------

function cmdFormat(f: Flags, io: Io): number {
  checkKnown(f, KNOWN.format);
  if (!f.pos.length) throw new Error("format needs at least one file or folder");
  const opts: FormatOptions = applyProjectFormat({ indent: 2, indentSeq: true, sortKubernetesKeys: true }, configFor(f, f.pos[0], io));
  if (f.opts.has("--indent")) opts.indent = Number(f.opts.get("--indent")!.at(-1));
  if (![2, 4].includes(opts.indent)) throw new Error("--indent must be 2 or 4");
  if (f.opts.has("--flush-lists")) opts.indentSeq = false;
  if (f.opts.has("--no-sort-k8s")) opts.sortKubernetesKeys = false;
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

// ---- merge -----------------------------------------------------------------------

function conflictLine(c: MergeConflict, showSecrets = false): string {
  const where = c.label + (c.path ? ` ${formatPath(c.path)}` : "");
  const v = (x: unknown) => show(isSecretKey(c.key) ? (showSecrets ? decodeSecretValue : hideSecretValue)(c.path ?? [], x) : x);
  return `conflict: ${where}: base ${v(c.base)}, ours ${v(c.ours)}, theirs ${v(c.theirs)}`;
}

function cmdMerge(f: Flags, io: Io): number {
  checkKnown(f, KNOWN.merge);
  if (f.pos.length !== 3) throw new Error("merge needs three files: <base> <ours> <theirs>");
  const prefer = f.opts.get("--prefer")?.at(-1);
  if (prefer !== undefined && prefer !== "ours" && prefer !== "theirs") throw new Error("--prefer must be ours or theirs");
  const out = (f.opts.get("-o") ?? f.opts.get("--out"))?.at(-1);
  const quiet = f.opts.has("-q") || f.opts.has("--quiet");
  for (const p of f.pos) if (kindOf(p) !== "file") throw new Error(`${p}: not a file`);
  const [base, ours, theirs] = f.pos.map(read);
  const m = merge3(base.text, ours.text, theirs.text, compareOptions(f, configFor(f, f.pos[1], io)));
  if (m.errors.length) {
    m.errors.forEach((e) => io.err(e));
    return 2;
  }
  let text = m.text;
  if (prefer === "theirs")
    for (const c of m.conflicts) {
      const r = resolveConflict(text, theirs.text, c);
      if (r.errors.length) { r.errors.forEach((e) => io.err(e)); return 2; }
      text = r.text;
    }
  if (!quiet) m.conflicts.forEach((c) => io.err(conflictLine(c, f.opts.has("--show-secrets")) + (prefer ? ` → ${prefer}` : "")));
  if (m.conflicts.length && !prefer) {
    if (!quiet) io.err(`${m.conflicts.length} conflict(s), nothing written; resolve them in YAD or use --prefer`);
    return 1;
  }
  const bytes = encodeText({ ...ours, text });
  if (out) writeFileSync(out, bytes);
  else io.out(bytes.replace(/\r?\n$/, ""));
  return 0;
}

/**
 * git merge driver: `%O %A %B %P [%L]` — base, ours (the result goes here),
 * theirs, path, conflict marker size. Exit 0 when merged cleanly. On
 * semantic conflicts (or files YAD cannot parse) falls back to git's own
 * line merge, so the file gets the usual conflict markers.
 */
function cmdMergeDriver(args: string[], io: Io): number {
  if (args.length < 3) throw new Error("merge-driver is called by git (merge.<driver>.driver), not directly");
  const [baseFile, oursFile, theirsFile, path = oursFile, markers] = args;
  const [base, ours, theirs] = [baseFile, oursFile, theirsFile].map(read);
  const m = merge3(base.text, ours.text, theirs.text);
  if (!m.errors.length && !m.conflicts.length) {
    writeFileSync(oursFile, encodeText({ ...ours, text: m.text }));
    return 0;
  }
  if (m.errors.length) io.err(`yad: ${path}: ${m.errors[0]}`);
  else {
    m.conflicts.forEach((c) => io.err(`yad: ${path}: ${conflictLine(c)}`));
    io.err(`yad: ${path}: ${m.conflicts.length} conflict(s); resolve with "git mergetool -t yad"`);
  }
  const r = spawnSync("git", ["merge-file", ...(markers ? [`--marker-size=${markers}`] : []), "-L", "ours", "-L", "base", "-L", "theirs", oursFile, baseFile, theirsFile], { encoding: "utf8" });
  if (r.error) throw r.error;
  return r.status === 0 ? 0 : 1;
}

// ---- git -------------------------------------------------------------------------

/**
 * GIT_EXTERNAL_DIFF protocol: `path old-file old-hex old-mode new-file new-hex new-mode`
 * (a deleted or added file is /dev/null), or just `path` for an unmerged file.
 * Must exit 0, otherwise git stops.
 */
function cmdGitDiff(args: string[], io: Io): number {
  const showSecrets = args[0] === "--show-secrets";
  if (showSecrets) args = args.slice(1);
  if (args.length === 1) {
    io.out(`* Unmerged path ${args[0]}`);
    return 0;
  }
  if (args.length < 7) throw new Error("git-diff is called by git (diff.<driver>.command), not directly");
  const [path, oldFile, , , newFile] = args;
  const text = (p: string) => (p === "/dev/null" ? null : read(p).text);
  const color = io.color || process.env.GIT_PAGER_IN_USE === "true";
  const opts = applyProjectCompare(defaultOptions(), findProjectConfig(path, io, true));
  const [r] = withSecrets([diffTexts(path, text(oldFile), text(newFile), opts)], showSecrets);
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
      case "merge": return cmdMerge(parseArgs(rest), io);
      case "merge-driver": return cmdMergeDriver(rest, io);
      case "--version": case "-v": io.out(VERSION); return 0;
      case undefined: case "help": case "--help": case "-h": io.out(HELP); return cmd ? 0 : 2;
      default: throw new Error(`unknown command ${cmd}`);
    }
  } catch (e) {
    io.err(`yad-cli: ${e instanceof Error ? e.message : String(e)}`);
    if (cmd !== "git-diff" && cmd !== "merge-driver") io.err("Run yad-cli --help for usage.");
    return 2;
  }
}

