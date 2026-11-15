<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open, ask, message } from "@tauri-apps/plugin-dialog";
  import type { Chunk } from "@codemirror/merge";
  import type { ChangeDesc } from "@codemirror/state";
  import DiffView from "./lib/DiffView.svelte";
  import ResourceList from "./lib/ResourceList.svelte";
  import FileList from "./lib/FileList.svelte";
  import HistoryList from "./lib/HistoryList.svelte";
  import Section from "./lib/Section.svelte";
  import Splitter from "./lib/Splitter.svelte";
  import Settings from "./lib/Settings.svelte";
  import { settings, compareOptions, effectiveTheme, formatOptions } from "./lib/prefs.svelte";
  import { t, tn } from "./lib/i18n.svelte";
  import { actionFor, comboOf, formatCombo, type ActionId } from "./lib/hotkeys";
  import {
    readText, writeText, initialPaths, baseName, pathKind, listFiles, fileStamps, joinPath, type Side,
  } from "./lib/files";
  import {
    decodeText, diskChange, encodeText, isDirty, minimalEdit, otherSide, statusOf, storeEditorText, type Buf, type Entry, type Marker, type Op,
  } from "./lib/workspace";
  import {
    alignOrder, applyEdits, compareTexts, formatText, isJsonText, KIND_LABELS, formatPath, pathOn, locatePath, planApply, planRevert, planSemanticEdit, renderNormalized, shortPath,
    type ApplyItem, type Change, type CompareResult, type Direction, type NormalizedView,
    type ResourceDiff, type SourceRange, type Touched,
  } from "./lib/semantic";

  type Mode = "text" | "semantic";
  type Span = { from: number; to: number };
  type Source = { kind: "file" | "dir"; path: string };

  let raw: DiffView;
  let sem: DiffView;
  let work: HTMLElement;
  let fileList: FileList | undefined = $state();

  // ---- side panel layout (sizes and collapsed sections are remembered) -----
  type PaneId = "files" | "changes" | "history";
  type Layout = { width: number; files: number; history: number; collapsed: Record<PaneId, boolean> };
  const LAYOUT_KEY = "yad.layout";
  const defaultLayout: Layout = { width: 320, files: 260, history: 160, collapsed: { files: false, changes: false, history: false } };
  function loadLayout(): Layout {
    try {
      const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
      if (v) return { ...defaultLayout, ...v, collapsed: { ...defaultLayout.collapsed, ...v.collapsed } };
    } catch {}
    return structuredClone(defaultLayout);
  }
  let layout = $state<Layout>(loadLayout());
  $effect(() => {
    const snapshot = JSON.stringify(layout);
    try { localStorage.setItem(LAYOUT_KEY, snapshot); } catch {}
  });
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const toggle = (id: PaneId) => (layout.collapsed[id] = !layout.collapsed[id]);

  // ---- workspace: two files, or two directories with many file pairs --------
  let sources = $state<Record<Side, Source | null>>({ a: null, b: null });
  let entries = $state<Entry[]>([]);
  let current = $state(-1);
  const dirMode = $derived(sources.a?.kind === "dir" || sources.b?.kind === "dir");
  const entry = $derived<Entry | undefined>(entries[current]);
  const anyDirty = () => entries.some((e) => isDirty(e.a) || isDirty(e.b));

  // Applies that can be undone one by one; the side Cmd+Z targets outside an editor.
  let ops = $state<Op[]>([]);
  let opSeq = 0;
  let lastSide: Side | null = null;

  let mode = $state<Mode>("semantic");
  let sidebar = $state(true);
  let chunks = $state(0);
  let collapse = $state(false);
  let dropTarget = $state<Side | null>(null);

  // Semantic state. `$state.raw`: results hold yaml nodes, which must not be proxied.
  const opts = $derived(compareOptions());
  let result = $state.raw<CompareResult | null>(null);
  let normalized = $state.raw<NormalizedView | null>(null);
  /** True while a whole document is being replaced (file switch): positions are not mapped. */
  let loading = false;
  // Editing the semantic view: changes are carried to the source after a short pause.
  let semTimer: ReturnType<typeof setTimeout> | undefined;
  let semSide: Side | null = null;
  let semError = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const theme = $derived(effectiveTheme());
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  let settingsOpen = $state(false);
  let settingsTab = $state<"general" | "comparison" | "formatting" | "hotkeys" | "about">("general");
  /** " (⌘S)" for tooltips, following the current bindings. */
  const hk = (a: ActionId) => (settings.hotkeys[a] ? ` (${formatCombo(settings.hotkeys[a])})` : "");

  // Comparison settings changed: re-evaluate every file and the current view.
  $effect(() => {
    const o = opts;
    untrack(() => {
      if (!raw || !sem) return;
      for (const e of entries) e.status = statusOf(e, undefined, o);
      recompute();
    });
  });

  const filters = [
    { name: "YAML / JSON", extensions: ["yaml", "yml", "json"] },
    { name: "All files", extensions: ["*"] },
  ];

  const changedCount = $derived(result?.resources.filter((r) => r.status !== "equal").length ?? 0);

  // ---- semantic recompute -------------------------------------------------

  function recompute() {
    clearTimeout(timer);
    timer = undefined;
    const e = entries[current];
    if (!e) {
      result = null;
      normalized = null;
      sem.setDocSoft("a", "");
      sem.setDocSoft("b", "");
      return;
    }
    result = compareTexts(raw.getDoc("a"), raw.getDoc("b"), opts);
    normalized = renderNormalized(result.resources, opts);
    for (const side of ["a", "b"] as const) {
      if (semSide === side) continue; // the user is typing there, or the text does not parse yet
      sem.setDocSoft(side, normalized[side]);
    }
    e.status = statusOf(e, result, opts);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(recompute, 200);
  }

  async function setMode(m: Mode) {
    flushSemantic();
    if (timer) recompute();
    mode = m;
    await tick();
  }

  // ---- loading ------------------------------------------------------------

  function confirmDiscard(side: Side) {
    if (!entries.some((e) => isDirty(e[side]))) return Promise.resolve(true);
    return ask(t("discardSide", { side: side === "a" ? t("left") : t("right") }), { title: t("unsavedTitle"), kind: "warning" });
  }

  async function openPath(side: Side, path: string) {
    const kind = await pathKind(path);
    if (kind === "missing") return message(t("notExist", { path }), { title: t("cannotOpen"), kind: "error" });
    if (!(await confirmDiscard(side))) return;

    // A folder on one side and a file on the other cannot be compared: reset the other side.
    const other = otherSide(side);
    if (sources[other] && sources[other]!.kind !== kind) {
      if (!(await confirmDiscard(other))) return;
      sources[other] = null;
      entries = [];
    }
    ops = ops.filter((o) => o.side !== side);
    try {
      if (kind === "file") await loadFile(side, path);
      else await loadDir(side, path);
      sources[side] = { kind, path };
    } catch (e) {
      return message(String(e), { title: t("cannotOpen"), kind: "error" });
    }
    const keep = entries[current]?.rel;
    let i = entries.findIndex((e) => e.rel === keep);
    if (i < 0) i = entries.findIndex((e) => e.status !== "equal" && e.status !== "reordered");
    selectEntry(Math.max(0, Math.min(i, entries.length - 1)));
  }

  async function loadFile(side: Side, path: string) {
    // Stamp first: a change made while reading is then still noticed later.
    const [stamp] = await fileStamps([path]);
    const { text, eol, bom } = decodeText(await readText(path));
    const buf: Buf = { path, saved: text, text, exists: true, eol, bom, stamp };
    const e = entries.length === 1 && entries[0].rel === "" ? entries[0] : { rel: "", status: "equal" as const };
    e[side] = buf;
    e.status = statusOf(e, undefined, opts);
    entries = [e];
  }

  async function loadDir(side: Side, root: string) {
    const rels = await listFiles(root);
    const stamps = await fileStamps(rels.map((rel) => joinPath(root, rel)));
    const texts = await Promise.all(rels.map((rel) => readText(joinPath(root, rel)).catch(() => null)));
    const byRel = new Map<string, Entry>();
    for (const e of entries) {
      if (e.rel === "") continue;
      delete e[side];
      byRel.set(e.rel, e);
    }
    rels.forEach((rel, i) => {
      if (texts[i] === null) return;
      const { text, eol, bom } = decodeText(texts[i]!);
      const e = byRel.get(rel) ?? { rel, status: "equal" };
      e[side] = { path: joinPath(root, rel), saved: text, text, exists: true, eol, bom, stamp: stamps[i] };
      byRel.set(rel, e);
    });
    entries = [...byRel.values()]
      .filter((e) => e.a || e.b)
      .sort((x, y) => (x.rel < y.rel ? -1 : 1))
      .map((e) => ({ ...e, status: statusOf(e, undefined, opts) }));
  }

  function selectEntry(i: number) {
    flushSemantic();
    current = i;
    const e = entries[i];
    loading = true;
    for (const side of ["a", "b"] as const) raw.setDoc(side, e?.[side]?.text ?? "", e?.[side]?.path ?? e?.rel ?? null, true);
    loading = false;
    for (const side of ["a", "b"] as const) sem.setDoc(side, "", "normalized.yaml", true);
    recompute();
  }

  async function pick(side: Side, directory: boolean) {
    const path = await open({ multiple: false, directory, filters: directory ? undefined : filters });
    if (typeof path === "string") await openPath(side, path);
  }

  // ---- editing & saving -----------------------------------------------------

  function onRawChange(side: Side, text: string) {
    const e = entries[current];
    if (!e) return;
    storeEditorText(e, side, text, sources[side]?.kind === "dir" ? sources[side]!.path : null);
    if (raw.focusedSide() === side) lastSide = side;
    schedule();
  }

  async function saveBuf(buf: Buf) {
    try {
      await writeText(buf.path, encodeText(buf));
      buf.saved = buf.text;
      buf.exists = true;
      [buf.stamp] = await fileStamps([buf.path]);
    } catch (e) {
      await message(String(e), { title: t("cannotSave"), kind: "error" });
    }
  }

  async function save(side: Side) {
    const buf = entries[current]?.[side];
    if (isDirty(buf)) await saveBuf(buf!);
  }

  async function saveAll() {
    for (const e of entries) for (const buf of [e.a, e.b]) if (isDirty(buf)) await saveBuf(buf!);
  }

  // ---- files changed outside YAD -------------------------------------------

  let checking = false;
  let notice = $state("");
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function showNotice(text: string) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ""), 8000);
  }

  /** Folder mode: files that appeared on disk since the folders were opened. */
  async function addNewFiles(): Promise<number> {
    let added = 0;
    for (const side of ["a", "b"] as const) {
      const src = sources[side];
      if (src?.kind !== "dir") continue;
      const rels = await listFiles(src.path).catch(() => [] as string[]);
      const fresh = rels.filter((rel) => !entries.find((e) => e.rel === rel)?.[side]);
      if (!fresh.length) continue;
      const paths = fresh.map((rel) => joinPath(src.path, rel));
      const stamps = await fileStamps(paths);
      const texts = await Promise.all(paths.map((p) => readText(p).catch(() => null)));
      if (sources[side] !== src) continue;
      fresh.forEach((rel, i) => {
        if (texts[i] === null) return;
        const { text, eol, bom } = decodeText(texts[i]!);
        const buf: Buf = { path: paths[i], saved: text, text, exists: true, eol, bom, stamp: stamps[i] };
        const e = entries.find((x) => x.rel === rel);
        if (e?.[side]) return;
        if (e) e[side] = buf;
        else entries.push({ rel, [side]: buf, status: "equal" });
        added++;
      });
    }
    if (added) {
      entries.sort((x, y) => (x.rel < y.rel ? -1 : 1));
      for (const e of entries) e.status = statusOf(e, undefined, opts);
    }
    return added;
  }

  /**
   * Pick up files changed, deleted or (with `rescan`, in folders) added
   * outside YAD. Clean files are reloaded quietly; unsaved edits are never
   * dropped without asking.
   */
  async function checkDisk(rescan: boolean) {
    if (checking || !entries.length) return;
    checking = true;
    try {
      flushSemantic();
      const keepRel = entries[current]?.rel;
      const reloaded: string[] = [], deleted: string[] = [];
      let structural = rescan && dirMode && (await addNewFiles()) > 0;
      const added = structural;
      let touchedCurrent = false;

      const items = entries.flatMap((e) => (["a", "b"] as const).flatMap((side) => (e[side] ? [{ e, side, buf: e[side]! }] : [])));
      const stamps = await fileStamps(items.map((x) => x.buf.path));
      for (const [i, { e, side, buf }] of items.entries()) {
        const stamp = stamps[i];
        if (stamp === (buf.stamp ?? null)) continue;
        const text = stamp === null ? null : await readText(buf.path).catch(() => null);
        const still = () => entries.includes(e) && e[side] === buf;
        if (!still()) continue;
        const disk = text === null ? null : decodeText(text);
        const name = e.rel || baseName(buf.path);
        let what = diskChange(buf, disk?.text ?? null);
        if (what === "conflict") {
          const reload = await ask(t("diskConflict", { name }), {
            title: t("changedOnDisk"), kind: "warning", okLabel: t("reloadFromDisk"), cancelLabel: t("keepMine"),
          });
          if (!still()) continue;
          if (!reload) {
            // Keep the edits; Save will overwrite the new disk version.
            Object.assign(buf, { saved: disk!.text, exists: true, stamp });
            continue;
          }
          what = "reload";
        }
        buf.stamp = stamp;
        if (what === "same") continue;
        const isCurrent = e === entries[current];
        const forget = () => (ops = ops.filter((o) => !(o.rel === e.rel && o.side === side)));
        if (what === "reload") {
          Object.assign(buf, { text: disk!.text, saved: disk!.text, eol: disk!.eol, bom: disk!.bom, exists: true });
          forget();
          if (isCurrent) {
            raw.setDocSoft(side, disk!.text, true);
            touchedCurrent = true;
          }
          reloaded.push(name);
        } else if (what === "gone" && dirMode) {
          delete e[side];
          forget();
          if (!e.a && !e.b) entries.splice(entries.indexOf(e), 1);
          structural = true;
          deleted.push(name);
        } else {
          // Deleted with unsaved edits, or the only file in two-file mode: keep the text, Save recreates it.
          Object.assign(buf, { exists: false, saved: what === "gone" ? "" : buf.saved });
          deleted.push(name);
        }
        e.status = statusOf(e, undefined, opts);
      }

      if (structural) {
        const i = entries.findIndex((e) => e.rel === keepRel);
        selectEntry(i >= 0 ? i : Math.max(0, Math.min(current, entries.length - 1)));
      } else if (touchedCurrent) recompute();

      const parts: string[] = [];
      const list = (names: string[]) => names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
      if (reloaded.length) parts.push(t("reloadedFromDisk", { names: list(reloaded) }));
      if (deleted.length) parts.push(t("deletedOnDisk", { names: list(deleted) }));
      if (added) parts.push(t("newFilesOnDisk"));
      if (parts.length) showNotice(parts.join(" · "));
    } finally {
      checking = false;
    }
  }

  // ---- applying semantic changes -------------------------------------------

  const changeKey = (r: ResourceDiff, c?: Change) => `${r.key}|${c ? formatPath(c.path) : ""}`;

  async function apply(items: ApplyItem[], dir: Direction) {
    flushSemantic();
    // Results may lag behind typing by the debounce: recompute and re-find the items.
    if (timer) {
      const wanted = new Set(items.map((it) => changeKey(it.resource, it.change)));
      recompute();
      items = [];
      for (const r of result?.resources ?? []) {
        if (wanted.has(changeKey(r))) items.push({ resource: r });
        for (const c of r.changes) if (wanted.has(changeKey(r, c))) items.push({ resource: r, change: c });
      }
    }
    if (!items.length) return;
    const target: Side = dir === "a-to-b" ? "b" : "a";
    const before = raw.getDoc(target);
    const existed = !!entries[current]?.[target];
    const plan = planApply(items, dir, before);
    raw.applyEdits(target, plan.edits);
    const after = raw.getDoc(target);
    if (after !== before) {
      const touched: Touched[] = items.map(({ resource: r, change: c }) => ({
        key: (r[target] ?? r[otherSide(target)])!.key,
        path: c && pathOn(c, target),
      }));
      record({ rel: entries[current]?.rel ?? "", side: target, label: describe(items, dir), before: existed ? before : null, after, touched });
    }
    recompute();
    if (plan.errors.length)
      await message(plan.errors.join("\n"), { title: t("someNotApplied"), kind: "warning" });
  }

  function describe(items: ApplyItem[], dir: Direction): string {
    const arrow = dir === "a-to-b" ? "→" : "←";
    if (items.length === 1) {
      const { resource: r, change: c } = items[0];
      return c ? `${arrow} ${shortPath(c.path)}` : `${arrow} ${r.label}`;
    }
    const names = [...new Set(items.map((i) => i.resource.label))];
    return `${arrow} ${t("nChangesIn", { n: items.length, names: names.join(", ") })}`;
  }

  function record(op: Omit<Op, "id">) {
    ops.push({ ...op, id: ++opSeq });
    lastSide = op.side;
  }

  /** Undo one recorded apply, keeping everything done after it. */
  async function revertOp(op: Op) {
    const e = entries.find((x) => x.rel === op.rel);
    if (!e) return;
    const isCurrent = e === entries[current];
    const cur = isCurrent ? raw.getDoc(op.side) : e[op.side]?.text ?? "";
    let next: string;
    if (cur === op.after) next = op.before ?? "";
    else if (op.touched) {
      const plan = planRevert(op.before ?? "", cur, op.touched, opts);
      if (plan.errors.length)
        await message(plan.errors.join("\n"), { title: t("partNotUndone"), kind: "warning" });
      next = applyEdits(cur, plan.edits);
    } else {
      await message(t("textBlockUndo", { key: formatCombo("Mod+Z") }), { title: t("cannotUndo"), kind: "info" });
      return;
    }
    ops = ops.filter((o) => o.id !== op.id);
    if (isCurrent) {
      raw.applyEdits(op.side, [minimalEdit(cur, next)]);
      if (op.before === null && !e[op.side]?.exists && next === "") delete e[op.side];
      recompute();
    } else {
      if (op.before === null && !e[op.side]?.exists) delete e[op.side];
      else if (e[op.side]) e[op.side]!.text = next;
      e.status = statusOf(e, undefined, opts);
    }
    lastSide = op.side;
  }

  /** Arrow in the text view: copy the block like Meld, recorded for undo. */
  function onTextArrow(chunk: Chunk, dir: Direction) {
    const target: Side = dir === "a-to-b" ? "b" : "a";
    const before = raw.getDoc(target);
    raw.copyChunk(chunk, dir);
    const after = raw.getDoc(target);
    if (after !== before) {
      const anchor = target === "b" ? chunk.fromB : chunk.fromA;
      record({ rel: entries[current]?.rel ?? "", side: target, label: `${dir === "a-to-b" ? "→" : "←"} ${t("textBlock")}`, before, after, anchor });
    }
  }

  /** Replace one side's whole text as a single undoable, recorded step. */
  function rewriteSide(side: Side, next: string, label: string) {
    const before = raw.getDoc(side);
    if (next === before) return false;
    const existed = !!entries[current]?.[side];
    raw.applyEdits(side, [minimalEdit(before, next)]);
    record({ rel: entries[current]?.rel ?? "", side, label, before: existed ? before : null, after: raw.getDoc(side), anchor: 0 });
    recompute();
    return true;
  }

  async function formatSide(side: Side) {
    flushSemantic();
    const r = formatText(raw.getDoc(side), formatOptions());
    if (r.error !== undefined) return message(r.error, { title: t("cannotFormat"), kind: "warning" });
    if (!rewriteSide(side, r.text, `✨ ${t("opFormat")}`)) await message(t("alreadyFormatted"), { title: t("format"), kind: "info" });
  }

  async function alignSide(side: Side) {
    flushSemantic();
    const r = alignOrder(raw.getDoc(side), raw.getDoc(otherSide(side)), opts);
    if (r.error !== undefined) return message(r.error, { title: t("cannotAlign"), kind: "warning" });
    if (!rewriteSide(side, r.text, `⇅ ${t("opAlign")}`)) await message(t("orderMatches"), { title: t("align"), kind: "info" });
  }

  /** Format or align every file on one side (directory mode); one History step per file. */
  async function bulk(kind: "format" | "align", side: Side) {
    flushSemantic();
    const label = kind === "format" ? `✨ ${t("opFormat")}` : `⇅ ${t("opAlign")}`;
    const fo = formatOptions();
    let changed = 0;
    const skipped: string[] = [];
    for (const e of entries) {
      const buf = e[side];
      const other = e[otherSide(side)];
      if (!buf || (kind === "align" && !other)) continue;
      const isCurrent = e === entries[current];
      const before = isCurrent ? raw.getDoc(side) : buf.text;
      if (!before.trim()) continue;
      const r = kind === "format" ? formatText(before, fo) : alignOrder(before, isCurrent ? raw.getDoc(otherSide(side)) : other!.text, opts);
      if (r.error !== undefined) {
        skipped.push(`${e.rel}: ${r.error}`);
        continue;
      }
      if (r.text === before) continue;
      changed++;
      if (isCurrent) rewriteSide(side, r.text, label);
      else {
        record({ rel: e.rel, side, label, before, after: r.text, anchor: 0 });
        buf.text = r.text;
        e.status = statusOf(e, undefined, opts);
      }
    }
    const lines = [changed ? `${tn("bulkDone", changed)} ${t("bulkUnsaved", { key: formatCombo(settings.hotkeys.saveAll || "Mod+Shift+S") })}` : t("bulkNothing")];
    if (skipped.length) lines.push("", t("bulkSkipped"), ...skipped.slice(0, 20), ...(skipped.length > 20 ? ["…"] : []));
    await message(lines.join("\n"), { title: kind === "format" ? t("format") : label, kind: skipped.length ? "warning" : "info" });
  }

  /** "Kubernetes", "GitHub Actions · JSON", … for a side's header. */
  function kindBadge(side: Side): string {
    const text = entry?.[side]?.text;
    if (!text?.trim()) return "";
    const kinds = [...new Set(result?.resources.map((r) => r[side]?.docKind).filter(Boolean))];
    const label = kinds.length === 1 ? KIND_LABELS[kinds[0]!] : kinds.length > 1 ? KIND_LABELS.yaml : "";
    return isJsonText(text) ? (label && label !== "YAML" ? `${label} · JSON` : "JSON") : label;
  }

  /** Keep text-copy anchors in place while the document is edited. */
  function onRawTx(side: Side, changes: ChangeDesc) {
    if (loading) return;
    const rel = entries[current]?.rel;
    for (const op of ops) if (op.rel === rel && op.side === side && op.anchor !== undefined) op.anchor = changes.mapPos(op.anchor);
  }

  /** Where to draw each undoable apply's ✕ in the text or semantic view. */
  function markersFor(view: Mode): Marker[] {
    const e = entries[current];
    if (!e) return [];
    const out: Marker[] = [];
    for (const op of ops) {
      if (op.rel !== e.rel) continue;
      let pos: number | undefined;
      const t = op.touched?.[0];
      if (t) {
        const r = result?.resources.find((x) => x.key === t.key || x.a?.key === t.key || x.b?.key === t.key);
        if (!r) continue;
        if (view === "semantic") pos = normalized?.locate(op.side, r.key, t.path)?.from;
        else {
          const tr = r[op.side];
          pos = tr ? locatePath(tr.node, t.path ?? [], tr.ctx)?.from : undefined;
        }
      } else if (view === "text") pos = op.anchor;
      if (pos !== undefined) out.push({ id: op.id, side: op.side, pos, title: op.label });
    }
    return out;
  }
  const rawMarkers = $derived(markersFor("text"));
  const semMarkers = $derived(markersFor("semantic"));

  function onmarker(id: number) {
    const op = ops.find((o) => o.id === id);
    if (op) revertOp(op);
  }

  // ---- editing in the semantic view -------------------------------------------

  function onSemanticUserEdit(side: Side) {
    if (semSide && semSide !== side) flushSemantic();
    semSide = side;
    lastSide = side;
    clearTimeout(semTimer);
    semTimer = setTimeout(() => syncSemantic(side), 350);
  }

  function flushSemantic() {
    if (semTimer && semSide) syncSemantic(semSide);
  }

  /** Carry what the user changed in the normalized text over to the source file. */
  function syncSemantic(side: Side) {
    clearTimeout(semTimer);
    semTimer = undefined;
    semSide = null;
    if (!normalized || !entries[current]) return;
    const plan = planSemanticEdit(normalized[side], sem.getDoc(side), raw.getDoc(side), opts);
    if (plan.parseError) {
      semError = t("semParseError", { side: side === "a" ? t("sideLeft") : t("sideRight"), line: plan.parseError.line, message: plan.parseError.message.split("\n")[0] });
      semSide = side; // keep this side's text until it parses
      return;
    }
    semError = plan.errors.length ? t("semNotApplied", { errors: plan.errors.join("; ") }) : null;
    if (plan.edits.length) raw.applyEdits(side, plan.edits);
    recompute();
  }

  /** Arrow in the semantic view: apply the changes inside that chunk. */
  function onSemanticArrow(chunk: Chunk, dir: Direction) {
    if (!result || !normalized) return;
    const hit = (s: SourceRange | undefined, from: number, to: number) => !!s && to > from && s.from < to && s.to > from;
    const items: ApplyItem[] = [];
    for (const r of result.resources) {
      if (r.status === "equal") continue;
      if (!r.a || !r.b) {
        const side: Side = r.a ? "a" : "b";
        const span = normalized.locate(side, r.key);
        if (side === "a" ? hit(span, chunk.fromA, chunk.toA) : hit(span, chunk.fromB, chunk.toB)) items.push({ resource: r });
        continue;
      }
      for (const c of r.changes) {
        const inA = c.kind !== "added" && hit(normalized.locate("a", r.key, pathOn(c, "a")), chunk.fromA, chunk.toA);
        const inB = c.kind !== "removed" && hit(normalized.locate("b", r.key, pathOn(c, "b")), chunk.fromB, chunk.toB);
        if (inA || inB) items.push({ resource: r, change: c });
      }
    }
    apply(items, dir);
  }

  // ---- navigation ---------------------------------------------------------

  const point = (r?: SourceRange): Span | undefined => r && { from: r.from, to: r.from };
  const span = (r?: SourceRange): Span | undefined => r && { from: r.from, to: r.to };

  /** Ranges of a change in the original texts; the side without it gets a cursor at the nearest parent. */
  function sourceSpans(r: ResourceDiff, c: Change): Partial<Record<Side, Span>> {
    const near = (side: Side) => {
      const res = r[side];
      return res && point(locatePath(res.node, pathOn(c, side), res.ctx));
    };
    return { a: span(c.aRange) ?? near("a"), b: span(c.bRange) ?? near("b") };
  }

  function onresource(r: ResourceDiff) {
    if (mode === "semantic" && normalized)
      sem.select({ a: point(normalized.locate("a", r.key)), b: point(normalized.locate("b", r.key)) });
    else raw.select({ a: point(r.a?.range), b: point(r.b?.range) });
  }

  function onchangeClick(r: ResourceDiff, c: Change) {
    if (mode === "semantic" && normalized) {
      const loc = (side: Side) => {
        const has = side === "a" ? c.kind !== "added" : c.kind !== "removed";
        const l = normalized!.locate(side, r.key, pathOn(c, side));
        return has ? span(l) : point(l);
      };
      sem.select({ a: loc("a"), b: loc("b") }, c.kind === "removed" ? "a" : "b");
    } else raw.select(sourceSpans(r, c), c.kind === "removed" ? "a" : "b");
  }

  async function onedit(r: ResourceDiff, c: Change) {
    await setMode("text");
    raw.select(sourceSpans(r, c), c.kind === "removed" ? "a" : "b");
  }

  /** Show the place under the semantic cursor in the source view (Cmd+J). */
  async function showInSource(side: Side, pos: number) {
    const hit = normalized?.pathAt(side, pos);
    const r = hit && result?.resources.find((x) => x.key === hit.key);
    const s: Side = r?.[side] ? side : otherSide(side);
    const res = r?.[s];
    await setMode("text");
    if (!res || !hit) return;
    raw.select({ [s]: point(locatePath(res.node, hit.path, res.ctx)) }, s);
  }

  const active = () => (mode === "text" ? raw : sem);

  /** App shortcuts (rebindable in Settings), checked before the editors see the key. */
  function onhotkey(e: KeyboardEvent) {
    if (settingsOpen) return; // the Settings window handles its own keys
    const action = actionFor(comboOf(e), settings.hotkeys);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    run(action);
  }

  function run(action: ActionId) {
    switch (action) {
      case "settings": settingsOpen = true; break;
      case "save": {
        const side = (mode === "text" ? raw : sem).focusedSide();
        flushSemantic();
        if (side) save(side);
        else { save("a"); save("b"); }
        break;
      }
      case "saveAll": flushSemantic(); saveAll(); break;
      case "openFileLeft": pick("a", false); break;
      case "openFileRight": pick("b", false); break;
      case "openFolderLeft": pick("a", true); break;
      case "openFolderRight": pick("b", true); break;
      case "modeSemantic": setMode("semantic"); break;
      case "modeSource": setMode("text"); break;
      case "showInSource":
        if (mode === "semantic") {
          const side = sem.focusedSide() ?? "b";
          flushSemantic();
          showInSource(side, sem.cursor(side));
        }
        break;
      case "toggleSidebar": sidebar = !sidebar; break;
      case "prevDiff": active().jump(-1); break;
      case "nextDiff": active().jump(1); break;
      case "prevFile": if (dirMode) fileList?.move(-1); break;
      case "nextFile": if (dirMode) fileList?.move(1); break;
    }
  }

  /** Cmd+Z that no editor handled (nothing to undo there, or focus in the side panel). */
  function onkey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (settingsOpen || !mod || e.code !== "KeyZ" || e.defaultPrevented) return;
    const side = lastSide;
    if (!side) return;
    flushSemantic();
    e.preventDefault();
    if (e.shiftKey) raw.redo(side);
    else raw.undo(side);
  }

  onMount(() => {
    const unlisten: Array<Promise<() => void>> = [];

    // Drop on the left/right half of the diff area; two paths at once fill both sides.
    unlisten.push(
      getCurrentWebview().onDragDropEvent((ev) => {
        const p = ev.payload;
        const sideAt = (x: number): Side => {
          const rect = work.getBoundingClientRect();
          return x / window.devicePixelRatio < rect.left + rect.width / 2 ? "a" : "b";
        };
        if (p.type === "enter" || p.type === "over") dropTarget = sideAt(p.position.x);
        else if (p.type === "leave") dropTarget = null;
        else if (p.type === "drop") {
          dropTarget = null;
          if (p.paths.length >= 2) openPath("a", p.paths[0]).then(() => openPath("b", p.paths[1]));
          else if (p.paths.length === 1) openPath(sideAt(p.position.x), p.paths[0]);
        }
      }),
    );

    const win = getCurrentWindow();
    unlisten.push(
      win.onCloseRequested(async (ev) => {
        if (!anyDirty()) return;
        ev.preventDefault();
        const ok = await ask(t("quitAnyway"), { title: t("unsavedTitle"), kind: "warning" });
        if (ok) await win.destroy();
      }),
    );

    // Files edited elsewhere (an editor, git pull…): check on return to the window and every 2 s while focused.
    unlisten.push(win.onFocusChanged(({ payload }) => void (payload && checkDisk(true))));
    const poll = setInterval(() => document.hasFocus() && checkDisk(false), 2000);

    initialPaths().then(async ([a, b]) => {
      if (a) await openPath("a", a);
      if (b) await openPath("b", b);
    });

    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      unlisten.forEach((u) => u.then((f) => f()));
    };
  });
</script>

<svelte:window onkeydowncapture={onhotkey} onkeydown={onkey} />

<main>
  <div class="body">
    {#if sidebar}
      {@const c = layout.collapsed}
      {@const showHistory = ops.length > 0}
      <!-- The first open pane of changes → files → history takes the free space. -->
      {@const filler = !c.changes ? "changes" : dirMode && !c.files ? "files" : showHistory && !c.history ? "history" : null}
      {@const paneStyle = (id: PaneId, h: number) =>
        c[id] ? "flex: none" : filler === id ? "flex: 1 1 0; min-height: 80px" : `flex: none; height: ${h}px`}
      <aside style="width: {layout.width}px">
        {#if dirMode}
          <Section title={t("files")} badge={entries.length} collapsed={c.files} ontoggle={() => toggle("files")} style={paneStyle("files", layout.files)}>
            <FileList bind:this={fileList} {entries} {current} onselect={selectEntry} onbulk={bulk} />
          </Section>
          {#if !c.files && !c.changes}
            <Splitter ondrag={(d) => (layout.files = clamp(layout.files + d, 60, window.innerHeight - 200))} />
          {/if}
        {/if}
        <Section title={t("changes")} badge={result ? result.resources.reduce((n, r) => n + (r.status === "equal" ? 0 : r.changes.length || 1), 0) : ""}
          collapsed={c.changes} ontoggle={() => toggle("changes")} style={paneStyle("changes", 0)}>
          <ResourceList {result} {onresource} onchange={onchangeClick} {onedit} onapply={apply} />
        </Section>
        {#if showHistory}
          {#if !c.history && !c.changes}
            <Splitter ondrag={(d) => (layout.history = clamp(layout.history - d, 60, window.innerHeight - 200))} />
          {/if}
          <Section title={t("history")} badge={ops.length} collapsed={c.history} ontoggle={() => toggle("history")} style={paneStyle("history", layout.history)}>
            <HistoryList {ops} showFiles={dirMode} onrevert={revertOp} />
          </Section>
        {/if}
      </aside>
      <Splitter dir="col" ondrag={(d) => (layout.width = clamp(layout.width + d, 200, 700))} />
    {/if}

    <section class="work" bind:this={work}>
      <header>
        {#each ["a", "b"] as const as side}
          {@const src = sources[side]}
          {@const buf = entry?.[side]}
          <div class="pane" class:drop={dropTarget === side}>
            <div class="open">
              <button onclick={() => pick(side, false)} title={side === "a" ? t("openFileLeft") + hk("openFileLeft") : t("openFileRight") + hk("openFileRight")}>{t("openFile")}</button>
              <button onclick={() => pick(side, true)} title={side === "a" ? t("openFolderLeft") + hk("openFolderLeft") : t("openFolderRight") + hk("openFolderRight")}>{t("openFolder")}</button>
            </div>
            <span class="path" title={buf?.path ?? src?.path ?? ""}>
              {#if !src}
                <i>{t("dropHere")}</i>
              {:else if dirMode}
                <b>{entry ? entry.rel : "—"}{isDirty(buf) ? " ✎" : ""}{entry && !buf ? ` ${t("missing")}` : ""}</b>
                <small>{src.path}</small>
              {:else}
                <b>{baseName(src.path)}{isDirty(buf) ? " ✎" : ""}</b>
                <small>{src.path}</small>
              {/if}
            </span>
            {#if kindBadge(side)}<span class="badge" title={kindBadge(side)}>{kindBadge(side)}</span>{/if}
            <button onclick={() => formatSide(side)} disabled={!buf} title={t("formatTitle")}>{t("format")}</button>
            <button onclick={() => alignSide(side)} disabled={!buf || !entry?.[otherSide(side)]}
              title={side === "a" ? t("alignTitleRight") : t("alignTitleLeft")}>{t("align")}</button>
            <button onclick={() => save(side)} disabled={!isDirty(buf)} title={t("saveTitle") + hk("save")}>{t("save")}</button>
          </div>
        {/each}
      </header>

      <div class="views">
        <div class="view" class:hidden={mode !== "text"}>
          <DiffView bind:this={raw} {theme} {collapse} onarrow={onTextArrow} onchange={onRawChange} ontx={onRawTx}
            onchunks={(n) => (chunks = n)} markers={rawMarkers} {onmarker} />
        </div>
        <div class="view" class:hidden={mode !== "semantic"}>
          <DiffView bind:this={sem} {theme} {collapse} onarrow={onSemanticArrow} onuseredit={onSemanticUserEdit}
            markers={semMarkers} {onmarker} />
        </div>
      </div>
    </section>
  </div>

  <footer>
    <button class="toggle" class:on={sidebar} onclick={() => (sidebar = !sidebar)} title={t("toggleSidebar") + hk("toggleSidebar")}>☰</button>
    <div class="segmented" role="tablist">
      <button class:on={mode === "semantic"} onclick={() => setMode("semantic")} title={t("semanticTitle") + hk("modeSemantic")}>{t("semantic")}</button>
      <button class:on={mode === "text"} onclick={() => setMode("text")} title={t("sourceTitle") + hk("modeSource")}>{t("source")}</button>
    </div>
    {#if mode === "text"}
      <span>{tn("differences", chunks)}</span>
    {:else}
      <span>{t("resourcesDiffer", { n: changedCount, total: result?.resources.length ?? 0 })}</span>
    {/if}
    <button onclick={() => active().jump(-1)} title={t("prevDiff") + hk("prevDiff")}>↑</button>
    <button onclick={() => active().jump(1)} title={t("nextDiff") + hk("nextDiff")}>↓</button>
    {#if mode === "semantic"}
      {#if semError}
        <span class="error" title={semError}>{semError}</span>
      {:else}
        <span class="hint">{t("semanticHint", { key: formatCombo(settings.hotkeys.showInSource) })}</span>
      {/if}
    {/if}
    <span class="spacer"></span>
    {#if notice}<span class="notice" title={notice}>{notice}</span>{/if}
    {#if dirMode}
      <button onclick={saveAll} disabled={!anyDirty()} title={t("saveAllTitle") + hk("saveAll")}>{t("saveAll")}</button>
    {/if}
    <label><input type="checkbox" bind:checked={collapse} /> {t("collapseUnchanged")}</label>
    <button class="gear" onclick={() => (settingsOpen = true)} title={t("settings") + hk("settings")}>⚙</button>
  </footer>
</main>

{#if settingsOpen}
  <Settings bind:tab={settingsTab} onclose={() => (settingsOpen = false)} />
{/if}

<style>
  main { display: flex; flex-direction: column; height: 100vh; }
  .body { flex: 1; min-height: 0; display: flex; }
  aside { flex: none; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--border); min-height: 0; overflow: hidden; }
  .work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .views { flex: 1; min-height: 0; display: flex; }
  .view { flex: 1; min-width: 0; display: flex; }
  .view.hidden { display: none; }
  header { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .pane { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--panel); min-width: 0; transition: background 0.1s; }
  .pane.drop { background: var(--accent-soft); outline: 2px dashed var(--accent); outline-offset: -3px; }
  .open { display: flex; gap: 4px; }
  .badge { flex: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;
    padding: 1px 6px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted); }
  .path { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
  .path b, .path small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path small, .path i { color: var(--muted); font-size: 11px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--panel); border-top: 1px solid var(--border); font-size: 12px; white-space: nowrap; }
  .hint { color: var(--muted); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .error { color: var(--removed); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .notice { color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 40%; }
  .spacer { flex: 1; }
  label { display: flex; align-items: center; gap: 4px; }
  .segmented { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; flex: none; }
  .segmented button { all: unset; padding: 2px 10px; cursor: default; }
  .segmented button + button { border-left: 1px solid var(--border); }
  .segmented button.on, .toggle.on { background: var(--accent); color: var(--accent-text); }
  .toggle { padding: 2px 8px; }
  .gear { padding: 0 6px; font-size: 14px; background: none; border: none; color: var(--muted); }
  .gear:hover { color: var(--text); }
</style>
