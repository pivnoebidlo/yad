<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open, ask, message, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import type { Chunk } from "@codemirror/merge";
  import type { ChangeDesc } from "@codemirror/state";
  import DiffView from "./lib/DiffView.svelte";
  import { copyChunkText, lineOf, lineStarts, splitChunk, type Part, type PartItem } from "./lib/chunkParts";
  import ResourceList from "./lib/ResourceList.svelte";
  import FileList from "./lib/FileList.svelte";
  import HistoryList from "./lib/HistoryList.svelte";
  import Section from "./lib/Section.svelte";
  import Splitter from "./lib/Splitter.svelte";
  import Settings from "./lib/Settings.svelte";
  import ConflictList, { type Pick } from "./lib/ConflictList.svelte";
  import { settings, compareOptions, effectiveTheme, formatOptions } from "./lib/prefs.svelte";
  import { t, tn } from "./lib/i18n.svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import {
    addFavorite, addRecent, clearRecent, loadFavorites, loadRecent, loadSession, pairTitle, removeFavorite, removeRecent, saveSession,
    type Favorite, type Recent, type Source as SessionSource,
  } from "./lib/session";
  import { findUpdate, installUpdate, type Update } from "./lib/updates";
  import { CONFIG_NAME, applyProjectCompare, applyProjectFormat, parseProjectConfig, type ProjectConfig } from "./lib/projectConfig";
  import { actionFor, comboOf, formatCombo, isMac, type ActionId } from "./lib/hotkeys";
  import {
    readText, writeText, initialPaths, baseName, pathKind, listFiles, fileStamps, joinPath, projectKind, render, mergeArgs, exitApp, findConfig, type RenderTool, type Side,
  } from "./lib/files";
  import {
    decodeText, diskChange, encodeText, isDirty, minimalEdit, otherSide, statusOf, storeEditorText, type Buf, type Entry, type Marker, type Op,
  } from "./lib/workspace";
  import {
    alignOrder, applyEdits, compareTexts, formatText, isJsonText, KIND_LABELS, formatPath, pathOn, locatePath, planApply, planRevert, planSemanticEdit, renderNormalized, shortPath, merge3, resolveConflict,
    type ApplyItem, type Change, type CompareResult, type Direction, type NormalizedView, isMultiline,
    type ResourceDiff, type SourceRange, type Touched, type MergeConflict,
  } from "./lib/semantic";

  type Mode = "text" | "semantic";
  type Span = { from: number; to: number };
  /** A file, a folder, or a Kustomize/Helm folder shown as its rendered output (see session.ts). */
  type Source = SessionSource;
  /** Rendered output is compared like a single file. */
  const shape = (k: Source["kind"]) => (k === "dir" ? "dir" : "file");

  let raw: DiffView;
  let sem: DiffView;
  let work: HTMLElement;
  let fileList: FileList | undefined = $state();
  let resourceList: ResourceList | undefined = $state();

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
  /**
   * The sidebar's header strip in the top bar: as wide as the panel while it
   * is open; collapsed — only the traffic-light zone (macOS) and the handle.
   * The stub is constant: panel tools disappear with the panel.
   */
  const headWidth = $derived(sidebar ? Math.max(layout.width, isMac ? 110 : 40) : isMac ? 110 : 40);
  /** Windows draws its own window controls in the top bar (the frame is off). */
  const winControls = /Win/.test(navigator.platform);
  let chunks = $state(0);
  let collapse = $state(false);
  let dropTarget = $state<Side | null>(null);

  // Semantic state. `$state.raw`: results hold yaml nodes, which must not be proxied.
  /** `.yad.yaml` of the compared project: its settings override personal ones. */
  let project = $state.raw<{ path: string; text: string; config: ProjectConfig; errors: string[] } | null>(null);
  const opts = $derived(applyProjectCompare(compareOptions(), project?.config));
  const fmtOptions = () => applyProjectFormat(formatOptions(), project?.config);
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

  /** The editor that had focus before Settings opened; it gets the keyboard back on close. */
  let settingsFrom: { v: DiffView; side: Side } | null = null;
  function openSettings() {
    const v = mode === "text" ? raw : sem;
    const side = v?.focusedSide();
    if (side) settingsFrom = { v, side };
    favMenu = null; // the menu does not hang over the dialog
    settingsOpen = true;
  }
  function closeSettings() {
    settingsOpen = false;
    settingsFrom?.v.focus(settingsFrom.side);
    settingsFrom = null;
  }

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
    // A single document: the hidden side mirrors the visible one, so the diff
    // never paints the whole text as one giant change.
    const from: Side | null = singleDoc ? (hasA() ? "a" : "b") : null;
    if (from) raw.setDocSoft(otherSide(from), raw.getDoc(from));
    result = compareTexts(raw.getDoc("a"), raw.getDoc("b"), opts);
    normalized = renderNormalized(result.resources, opts);
    for (const side of ["a", "b"] as const) {
      if (semSide === side) continue; // the user is typing there, or the text does not parse yet
      sem.setDocSoft(side, normalized[side]);
    }
    if (from) sem.setDocSoft(otherSide(from), sem.getDoc(from));
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
    if (merge) return;
    const found = await pathKind(path);
    if (found === "missing") return message(t("notExist", { path }), { title: t("cannotOpen"), kind: "error" });
    let src: Source = { kind: found, path };
    if (found === "dir") {
      const tool = await projectKind(path);
      if (tool) {
        const rendered = await ask(t("renderAsk", { name: baseName(path), tool: tool === "helm" ? "Helm" : "Kustomize" }), {
          title: tool === "helm" ? "Helm" : "Kustomize", kind: "info", okLabel: t("renderRendered"), cancelLabel: t("renderFiles"),
        });
        if (rendered) {
          let values: string[] = [];
          if (tool === "helm") {
            const picked = await open({ multiple: true, directory: false, defaultPath: path, filters, title: t("pickValues") });
            values = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
          }
          src = { kind: "render", path, tool, values };
        }
      }
    }
    await openSource(side, src);
  }

  /**
   * Load a decided source into one side of the current tab. `quiet` (reopening
   * the last session) skips missing paths and failures instead of asking.
   */
  async function openSource(side: Side, src: Source, quiet = false): Promise<boolean> {
    const path = src.path;
    if (quiet && (await pathKind(path)) === "missing") return false;
    // Replacing one side of a full pair keeps the selected file; a new pair starts at the first difference.
    const hadPair = !!(sources.a && sources.b);
    if (!(await confirmDiscard(side))) return false;

    // A folder on one side and a file on the other cannot be compared: reset the other side.
    const other = otherSide(side);
    if (sources[other] && shape(sources[other]!.kind) !== shape(src.kind)) {
      if (!(await confirmDiscard(other))) return false;
      sources[other] = null;
      entries = [];
    }
    // Pasted text (no file behind it) is just as incomparable with a folder.
    if (shape(src.kind) === "dir" && !sources[other] && entries.some((e) => e[other])) {
      if (!(await confirmDiscard(other))) return false;
      entries = [];
    }
    ops = ops.filter((o) => o.side !== side);
    try {
      if (src.kind === "file") await loadFile(side, path);
      else if (src.kind === "render") await loadRender(side, src);
      else await loadDir(side, path);
      sources[side] = src;
      await loadProjectConfig();
    } catch (e) {
      if (!quiet) await message(String(e), { title: src.kind === "render" ? t("renderFailed") : t("cannotOpen"), kind: "error" });
      return false;
    }
    const keep = hadPair ? entries[current]?.rel : undefined;
    let i = keep === undefined ? -1 : entries.findIndex((e) => e.rel === keep);
    if (i < 0) i = entries.findIndex((e) => e.status !== "equal" && e.status !== "reordered");
    selectEntry(Math.max(0, Math.min(i, entries.length - 1)));
    // Not for git difftool / scripted starts (temporary paths) and not while reopening the session.
    if (sessionOn && sources.a && sources.b) recent = addRecent(recent, $state.snapshot(sources.a), $state.snapshot(sources.b));
    return true;
  }

  // ---- tabs, session and recent comparisons --------------------------------

  /** Everything that belongs to one comparison; the active tab lives in the variables above. */
  type TabState = {
    id: number;
    sources: Record<Side, Source | null>;
    entries: Entry[];
    current: number;
    ops: Op[];
    lastSide: Side | null;
    project: typeof project;
  };
  let tabSeq = 1;
  const emptyTab = (): TabState => ({ id: ++tabSeq, sources: { a: null, b: null }, entries: [], current: -1, ops: [], lastSide: null, project: null });
  let tabs = $state<TabState[]>([{ ...emptyTab(), id: 1 }]);
  let tabIndex = $state(0);
  /** Remember open tabs for the next start (off when started by git or with paths). */
  let sessionOn = $state(false);
  let recent = $state<Recent[]>(loadRecent());
  /** Saved comparisons, one click away: the star in the top bar. */
  let favorites = $state<Favorite[]>(loadFavorites());
  /** The favorites menu: anchored under the star; null while closed. */
  let favMenu = $state<{ x: number; y: number } | null>(null);
  /** The save form is shown instead of the list. */
  let favForm = $state(false);
  let favName = $state("");
  const canFav = $derived(!!sources.a && !!sources.b);
  const favDefaultName = $derived(canFav ? pairTitle(sources.a, sources.b, "") : "");
  const favKey = (x: Favorite) => `${x.name}|${x.a.path}|${x.b.path}`;

  /** Open both sides of a saved or recent pair, in a fresh tab when something is already open. */
  async function openPair(a: SessionSource, b: SessionSource) {
    if (merge) return;
    if (sources.a || sources.b) newTab();
    await openSource("a", a);
    await openSource("b", b);
  }

  async function openRecent(r: Recent) {
    await openPair(r.a, r.b);
  }

  async function openFavorite(item: Favorite) {
    favMenu = null;
    await openPair(item.a, item.b);
  }

  function saveFavorite() {
    if (!canFav) return;
    favorites = addFavorite(favorites, {
      name: favName.trim() || favDefaultName,
      a: $state.snapshot(sources.a) as SessionSource,
      b: $state.snapshot(sources.b) as SessionSource,
    });
    favForm = false;
  }

  /** Escape leaves the save form, the second one closes the menu. */
  function onFavKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (favForm) favForm = false;
    else favMenu = null;
  }

  function openFavMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    favMenu = { x: r.left, y: r.bottom + 4 };
    favForm = false;
  }

  /** Focus and select the save-form field. */
  const autofocus = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };

  const liveTab = (): TabState => ({ id: tabs[tabIndex].id, sources, entries, current, ops, lastSide, project });
  const tabOf = (i: number) => (i === tabIndex ? liveTab() : tabs[i]);
  const tabDirty = (t: TabState) => t.entries.some((e) => isDirty(e.a) || isDirty(e.b));
  const anyTabDirty = () => tabs.some((_, i) => tabDirty(tabOf(i)));

  /** Tab title: the sides' file names, or "Pasted text" when a side has no file yet. */
  function tabTitle(tb: TabState): string {
    return tb.sources.a || tb.sources.b
      ? pairTitle(tb.sources.a, tb.sources.b, t("newTab"))
      : tb.entries.some((e) => e.a || e.b) ? t("pasted") : t("newTab");
  }

  function loadTab(t: TabState) {
    sources = t.sources;
    entries = t.entries;
    ops = t.ops;
    lastSide = t.lastSide;
    project = t.project;
    semError = null;
    if (!t.entries.length) (document.activeElement as HTMLElement | null)?.blur?.(); // ⌘V then goes to the left side
    selectEntry(t.entries.length ? Math.max(0, t.current) : -1);
  }

  function switchTab(i: number) {
    if (i === tabIndex || i < 0 || i >= tabs.length || merge) return;
    flushSemantic();
    tabs[tabIndex] = liveTab();
    tabIndex = i;
    loadTab(tabs[i]);
    void checkDisk(true); // files may have changed while the tab was in the background
  }

  function newTab() {
    if (merge) return;
    flushSemantic();
    tabs[tabIndex] = liveTab();
    tabs.push(emptyTab());
    tabIndex = tabs.length - 1;
    loadTab(tabs[tabIndex]);
  }

  async function closeTab(i = tabIndex) {
    if (merge) return;
    if (tabDirty(tabOf(i)) && !(await ask(t("closeTabDirty"), { title: t("unsavedTitle"), kind: "warning" }))) return;
    flushSemantic();
    if (tabs.length === 1) {
      tabs[0] = emptyTab();
      tabIndex = 0;
      loadTab(tabs[0]);
      return;
    }
    if (i !== tabIndex) {
      tabs.splice(i, 1);
      if (i < tabIndex) tabIndex--;
      return;
    }
    tabs.splice(i, 1);
    tabIndex = Math.min(i, tabs.length - 1);
    loadTab(tabs[tabIndex]);
    void checkDisk(true);
  }

  /** Reopen the tabs of the last session (missing paths are skipped). */
  async function restoreSession() {
    const saved = loadSession();
    if (!saved) return;
    for (const [i, pair] of saved.tabs.entries()) {
      if (i > 0) newTab();
      if (pair.a) await openSource("a", pair.a, true);
      if (pair.b) await openSource("b", pair.b, true);
    }
    // Tabs whose files are all gone are dropped.
    for (let i = tabs.length - 1; i >= 0 && tabs.length > 1; i--) {
      const tb = tabOf(i);
      if (!tb.sources.a && !tb.sources.b) await closeTab(i);
    }
    switchTab(Math.min(saved.active, tabs.length - 1));
  }

  $effect(() => {
    if (!sessionOn) return;
    const pairs = tabs.map((tb, i) => (i === tabIndex ? sources : tb.sources)).map((p) => $state.snapshot(p));
    saveSession(pairs, tabIndex);
  });

  /** Put a buffer on one side of the single file pair. */
  function setSingle(side: Side, buf: Buf) {
    const e = entries.length === 1 && entries[0].rel === "" ? entries[0] : { rel: "", status: "equal" as const };
    e[side] = buf;
    e.status = statusOf(e, undefined, opts);
    entries = [e];
  }

  async function loadRender(side: Side, src: Source) {
    const { text } = decodeText(await render(src.tool!, src.path, src.values));
    setSingle(side, { path: src.path, saved: text, text, exists: true, eol: "\n", bom: false, readonly: true });
  }

  /** Run kustomize/helm again for a rendered side; returns whether the output changed. */
  async function rerender(side: Side, quiet = false): Promise<boolean> {
    const src = sources[side];
    const e = entries[0];
    if (src?.kind !== "render" || !e?.[side]) return false;
    let text: string;
    try {
      text = decodeText(await render(src.tool!, src.path, src.values)).text;
    } catch (err) {
      if (quiet) showNotice(`${t("renderFailed")}: ${String(err).split("\n")[0]}`);
      else await message(String(err), { title: t("renderFailed"), kind: "error" });
      return false;
    }
    const buf = e[side]!;
    if (sources[side] !== src || buf.text === text) return false;
    buf.text = buf.saved = text;
    if (e === entries[current]) {
      raw.setDocSoft(side, text, true);
      recompute();
    } else e.status = statusOf(e, undefined, opts);
    return true;
  }

  /** "kustomize build" / "helm template -f values-prod.yaml" for the header. */
  function renderLabel(src: Source): string {
    if (src.tool === "kustomize") return "kustomize build";
    return ["helm template", ...(src.values ?? []).map((v) => `-f ${baseName(v)}`)].join(" ");
  }

  async function loadFile(side: Side, path: string) {
    // Stamp first: a change made while reading is then still noticed later.
    const [stamp] = await fileStamps([path]);
    const { text, eol, bom } = decodeText(await readText(path));
    setSingle(side, { path, saved: text, text, exists: true, eol, bom, stamp });
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
    for (const side of ["a", "b"] as const) {
      const buf = e?.[side];
      raw.setDoc(side, buf?.text ?? "", buf?.readonly ? "rendered.yaml" : buf?.path ?? e?.rel ?? null, true);
      raw.setReadOnly(side, !!buf?.readonly);
      sem.setReadOnly(side, !!buf?.readonly);
    }
    loading = false;
    for (const side of ["a", "b"] as const) sem.setDoc(side, "", "normalized.yaml", true);
    recompute();
  }

  async function pick(side: Side, directory: boolean) {
    const path = await open({ multiple: false, directory, filters: directory ? undefined : filters });
    if (typeof path === "string") await openPath(side, path);
  }

  // ---- editing & saving -----------------------------------------------------

  /** An in-memory side: text pasted into an empty tab, not written anywhere yet. */
  const untitledBuf = (): Buf => ({ path: "", saved: "", text: "", exists: false, eol: "\n", bom: false });

  /** Editor "file name" for pasted text — only decides the syntax highlighting. */
  const untitledPath = (text: string) => (isJsonText(text) ? "pasted.json" : "pasted.yaml");

  function onRawChange(side: Side, text: string) {
    let e = entries[current];
    // Text typed or pasted into a side with no file of its own (an empty tab):
    // kept in memory; Save later asks where to write it.
    if (!e && text.trim() && !dirMode && !merge && !sources[side]) {
      e = { rel: "", status: "equal" };
      e[side] = untitledBuf();
      entries = [e];
      current = 0;
      raw.setDoc(side, text, untitledPath(text)); // the text is already there: only the language changes
    } else if (e && text.trim() && !e[side] && !dirMode && !merge && !sources[side]) {
      e[side] = untitledBuf();
      raw.setDoc(side, text, untitledPath(text));
    }
    if (!e) return;
    storeEditorText(e, side, text, sources[side]?.kind === "dir" ? sources[side]!.path : null);
    if (raw.focusedSide() === side) lastSide = side;
    // A single document: the hidden side mirrors it at once, so no chunk ever
    // pretends the whole text is new while the user types.
    if (singleDoc) raw.setDocSoft(otherSide(side), text);
    schedule();
  }

  /** Clipboard text becomes one side of the comparison; no file is behind it. */
  function pasteInto(side: Side, text: string) {
    if (merge) return;
    let e = entries[current];
    if (!e) {
      e = { rel: "", status: "equal" };
      entries = [e];
      current = 0;
    }
    if (!e[side]) e[side] = untitledBuf();
    e[side]!.text = text;
    void setMode("text"); // the text as pasted; Format pretty-prints it
    raw.setDoc(side, text, untitledPath(text), true);
    raw.setReadOnly(side, false);
    sem.setReadOnly(side, false);
    recompute();
  }

  /** Cmd+V with no editor focused: the clipboard text goes to the side of this tab that is still empty. */
  function onpaste(ev: ClipboardEvent) {
    if (merge || settingsOpen || dirMode) return;
    // An editor, a filter field or Settings takes the paste itself.
    if ((document.activeElement as HTMLElement | null)?.closest?.(".cm-editor, input, textarea, select")) return;
    const text = ev.clipboardData?.getData("text/plain");
    if (!text?.trim()) return;
    ev.preventDefault();
    const free: Side | null = !hasA() ? "a" : !hasB() ? "b" : null;
    if (free) pasteInto(free, text);
  }

  async function saveBuf(buf: Buf): Promise<boolean> {
    try {
      await writeText(buf.path, encodeText(buf));
      buf.saved = buf.text;
      buf.exists = true;
      [buf.stamp] = await fileStamps([buf.path]);
      return true;
    } catch (e) {
      await message(String(e), { title: t("cannotSave"), kind: "error" });
      return false;
    }
  }

  async function save(side: Side) {
    if (merge && side === "b") return void (await saveMerge());
    const buf = entries[current]?.[side];
    if (!isDirty(buf)) return;
    if (!buf!.path) return void (await saveUntitled(side, buf!));
    await saveBuf(buf!);
  }

  /** A side without a file (text pasted into an empty tab): Save asks where to write it. */
  async function saveUntitled(side: Side, buf: Buf) {
    const path = await saveDialog({ title: t("saveAsTitle"), filters });
    if (typeof path !== "string" || !path) return;
    buf.path = path;
    if (await saveBuf(buf)) sources[side] = { kind: "file", path }; // now it is a file like any other
  }

  async function saveAll() {
    for (const e of entries)
      for (const side of ["a", "b"] as const) {
        const buf = e[side];
        if (!isDirty(buf)) continue;
        if (!buf!.path) await saveUntitled(side, buf!);
        else await saveBuf(buf!);
      }
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
  /** Find `.yad.yaml` next to (or above) the compared paths; reloaded when it changes. */
  async function loadProjectConfig() {
    let found: [string, string] | null = null;
    for (const src of [merge ? sources.b : sources.a, merge ? null : sources.b]) {
      if (src && (found = await findConfig(src.path).catch(() => null))) break;
    }
    if (!found) {
      project = null;
      return;
    }
    const [path, text] = found;
    if (project?.path === path && project.text === text) return;
    const { config, errors } = parseProjectConfig(text);
    project = { path, text, config, errors };
    if (errors.length) showNotice(`${CONFIG_NAME}: ${errors.join("; ")}`);
  }

  async function checkDisk(rescan: boolean) {
    if (rescan) await loadProjectConfig();
    if (checking || !entries.length) return;
    checking = true;
    try {
      flushSemantic();
      const keepRel = entries[current]?.rel;
      const reloaded: string[] = [], deleted: string[] = [];
      let structural = rescan && dirMode && (await addNewFiles()) > 0;
      // Rendered sides: their sources may live anywhere (bases, values…), so just render again.
      const rerendered: string[] = [];
      if (rescan)
        for (const side of ["a", "b"] as const)
          if (sources[side]?.kind === "render" && (await rerender(side, true))) rerendered.push(baseName(sources[side]!.path));
      const added = structural;
      let touchedCurrent = false;

      const items = entries.flatMap((e) => (["a", "b"] as const).flatMap((side) => (e[side] && !e[side]!.readonly ? [{ e, side, buf: e[side]! }] : [])));
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
      if (rerendered.length) parts.push(t("rerendered", { names: rerendered.join(", ") }));
      if (reloaded.length) parts.push(t("reloadedFromDisk", { names: list(reloaded) }));
      if (deleted.length) parts.push(t("deletedOnDisk", { names: list(deleted) }));
      if (added) parts.push(t("newFilesOnDisk"));
      if (parts.length) showNotice(parts.join(" · "));
    } finally {
      checking = false;
    }
  }

  // ---- updates ---------------------------------------------------------------

  let update = $state.raw<Update | null>(null);
  let updating = false;

  /** Look for a newer release; `manual` (About → Check for updates) also reports "up to date" and errors. */
  async function checkUpdates(manual = false) {
    try {
      update = await findUpdate();
    } catch (e) {
      if (manual) await message(String(e), { title: t("updateFailed"), kind: "error" });
      return;
    }
    if (update && manual) {
      settingsOpen = false;
      settingsFrom = null; // a native dialog takes over: no editor to return to
      await offerUpdate();
    } else if (manual) await message(t("updateLatest", { v: await getVersion() }), { title: t("updateTitle"), kind: "info" });
  }

  async function offerUpdate() {
    if (!update || updating) return;
    const ok = await ask(t("updateAsk", { v: update.version, current: update.currentVersion }) + (update.body ? `\n\n${update.body.slice(0, 600)}` : ""),
      { title: t("updateTitle"), kind: "info" });
    if (!ok || (anyDirty() && !(await ask(t("updateDirty"), { title: t("updateTitle"), kind: "warning" })))) return;
    updating = true;
    try {
      await installUpdate(update, (p) => showNotice(t("updateDownloading", { p: p === null ? "" : `${Math.round(p * 100)}%` })));
    } catch (e) {
      await message(String(e), { title: t("updateFailed"), kind: "error" });
    } finally {
      updating = false;
    }
  }

  // ---- three-way merge (git mergetool) ------------------------------------

  type MergeShow = "theirs" | "ours" | "base";
  type MergeSession = {
    paths: Record<MergeShow, string>;
    texts: Record<MergeShow, string>;
    conflicts: MergeConflict[];
    choice: Array<Pick | undefined>;
    applied: number;
    show: MergeShow;
    /** The result was written to MERGED at least once. */
    saved: boolean;
  };
  let merge = $state<MergeSession | null>(null);
  /** True when nothing is open at all: the start hint and recent comparisons cover the editors. */
  const startScreen = $derived(!merge && !sources.a && !sources.b && !entries.some((e) => e.a || e.b));
  const hasA = () => !!sources.a || entries.some((e) => e.a);
  const hasB = () => !!sources.b || entries.some((e) => e.b);
  /** One text with nothing to compare: shown alone, full width (paste → pretty). */
  const singleDoc = $derived(!merge && !dirMode && hasA() !== hasB());

  /** `yad --merge BASE LOCAL REMOTE MERGED`: left shows a version, right the result. */
  async function startMerge([base, local, remote, merged]: string[]) {
    const read = async (p: string) => decodeText(await readText(p).catch(() => ""));
    const [b, l, r, onDisk] = await Promise.all([base, local, remote, merged].map(read));
    const [stamp] = await fileStamps([merged]);
    const m = merge3(b.text, l.text, r.text, opts);
    merge = {
      paths: { base, ours: local, theirs: remote },
      texts: { base: b.text, ours: l.text, theirs: r.text },
      conflicts: m.conflicts,
      choice: m.conflicts.map(() => undefined),
      applied: m.applied,
      show: "theirs",
      saved: false,
    };
    sources = { a: { kind: "file", path: remote }, b: { kind: "file", path: merged } };
    await loadProjectConfig();
    const e: Entry = {
      rel: "",
      status: "equal",
      a: { path: remote, saved: r.text, text: r.text, exists: true, eol: r.eol, bom: r.bom, readonly: true },
      // Starts dirty: the file on disk holds git's conflict markers until the result is saved.
      b: { path: merged, saved: onDisk.text, text: m.text, exists: true, eol: l.eol, bom: l.bom, stamp },
    };
    e.status = statusOf(e, undefined, opts);
    entries = [e];
    selectEntry(0);
    if (m.errors.length)
      await message(`${m.errors.slice(0, 10).join("\n")}\n\n${t("mergeFailedBody")}`, { title: t("mergeFailed"), kind: "warning" });
  }

  /** Switch the reference version on the left. */
  function showInMerge(which: MergeShow) {
    const e = entries[0];
    if (!merge || !e?.a || merge.show === which) return;
    flushSemantic();
    merge.show = which;
    const path = merge.paths[which];
    const text = merge.texts[which];
    e.a = { ...e.a, path, saved: text, text };
    sources.a = { kind: "file", path };
    raw.setDocSoft("a", text, true);
    recompute();
  }

  function pickConflict(i: number, side: Pick) {
    if (!merge) return;
    flushSemantic();
    const c = merge.conflicts[i];
    const r = resolveConflict(raw.getDoc("b"), merge.texts[side], c, opts);
    if (r.errors.length) return void message(r.errors.join("\n"), { title: t("someNotApplied"), kind: "warning" });
    const what = c.path ? shortPath(c.path) : c.label;
    rewriteSide("b", r.text, `${side === "ours" ? t("pickOurs") : t("pickTheirs")}: ${what}`);
    merge.choice[i] = side;
  }

  function onconflict(c: MergeConflict) {
    const r = result?.resources.find((x) => x.key === c.key || x.a?.key === c.key || x.b?.key === c.key);
    if (!r) return;
    if (mode === "semantic" && normalized) {
      sem.select({ a: point(normalized.locate("a", r.key, c.path)), b: point(normalized.locate("b", r.key, c.path)) }, "b");
      return;
    }
    const at = (side: Side) => {
      const res = r[side];
      return res && point(c.path ? locatePath(res.node, c.path, res.ctx) : res.range);
    };
    raw.select({ a: at("a"), b: at("b") }, "b");
  }

  async function saveMerge(): Promise<boolean> {
    if (!merge) return false;
    flushSemantic();
    const open = merge.choice.filter((c) => !c).length;
    if (open && !(await ask(tn("mergeUnresolvedSave", open), { title: t("mergeTitle"), kind: "warning" }))) return false;
    const buf = entries[0]?.b;
    if (!buf || !(await saveBuf(buf))) return false;
    merge.saved = true;
    return true;
  }

  async function finishMerge() {
    if (await saveMerge()) await exitApp(0);
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
    if (await refuseRendered(target)) return;
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
  async function onTextArrow(chunk: Chunk, dir: Direction) {
    const target: Side = dir === "a-to-b" ? "b" : "a";
    if (await refuseRendered(target)) return;
    const before = raw.getDoc(target);
    raw.copyChunk(chunk, dir);
    const after = raw.getDoc(target);
    if (after !== before) {
      const anchor = target === "b" ? chunk.fromB : chunk.fromA;
      record({ rel: entries[current]?.rel ?? "", side: target, label: `${dir === "a-to-b" ? "→" : "←"} ${t("textBlock")}`, before, after, anchor });
    }
  }

  /** Rendered output cannot be changed: say so instead. */
  async function refuseRendered(side: Side): Promise<boolean> {
    if (!entries[current]?.[side]?.readonly) return false;
    if (merge) await message(t("mergeReadOnly"), { title: t("mergeTitle"), kind: "info" });
    else await message(t("renderedReadOnly"), { title: t("renderRendered"), kind: "info" });
    return true;
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

  /** Pretty-print one side. `quiet` (the hotkey): "already formatted" becomes a notice, not a dialog. */
  async function formatSide(side: Side, quiet = false) {
    flushSemantic();
    const r = formatText(raw.getDoc(side), fmtOptions());
    if (r.error !== undefined) return message(r.error, { title: t("cannotFormat"), kind: "warning" });
    if (!rewriteSide(side, r.text, t("opFormat"))) {
      if (quiet) showNotice(t("alreadyFormatted"));
      else await message(t("alreadyFormatted"), { title: t("format"), kind: "info" });
    }
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
    const label = kind === "format" ? t("opFormat") : `⇅ ${t("opAlign")}`;
    const fo = fmtOptions();
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
  /** Start of the line `n` lines below `pos`, not past `max`. */
  function linesDown(text: string, pos: number, n: number, max: number): number {
    let p = pos;
    for (let i = 0; i < n; i++) {
      const nl = text.indexOf("\n", p);
      if (nl < 0 || nl + 1 > max) break;
      p = nl + 1;
    }
    return p;
  }

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
        let span: SourceRange | undefined, text = "";
        if (view === "semantic") {
          span = normalized?.locate(op.side, r.key, t.path);
          text = normalized?.[op.side] ?? "";
        } else {
          const tr = r[op.side];
          span = tr ? locatePath(tr.node, t.path ?? [], tr.ctx) : undefined;
          text = tr?.ctx.text ?? "";
        }
        pos = span && (op.lineInValue ? linesDown(text, span.from, op.lineInValue, span.to) : span.from);
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
    // Secret values are shown decoded: encode both texts back before comparing with the file.
    const plan = planSemanticEdit(normalized.encode(side, normalized[side]), normalized.encode(side, sem.getDoc(side)), raw.getDoc(side), opts);
    if (plan.parseError) {
      semError = t("semParseError", { side: side === "a" ? t("sideLeft") : t("sideRight"), line: plan.parseError.line, message: plan.parseError.message.split("\n")[0] });
      semSide = side; // keep this side's text until it parses
      return;
    }
    semError = plan.errors.length ? t("semNotApplied", { errors: plan.errors.join("; ") }) : null;
    if (plan.edits.length) raw.applyEdits(side, plan.edits);
    recompute();
  }

  /** Every semantic change with its place in the normalized texts (for the arrows). */
  const semItems = $derived.by(() => {
    const out: { item: ApplyItem; group: string; a?: SourceRange; b?: SourceRange }[] = [];
    if (!result || !normalized) return out;
    for (const r of result.resources) {
      if (r.status === "equal") continue;
      if (!r.a || !r.b) {
        const side: Side = r.a ? "a" : "b";
        out.push({ item: { resource: r }, group: r.key, [side]: normalized.locate(side, r.key) });
        continue;
      }
      for (const c of r.changes)
        out.push({
          item: { resource: r, change: c },
          group: `${r.key}|${formatPath(c.path.slice(0, -1))}`,
          a: c.kind !== "added" ? normalized.locate("a", r.key, pathOn(c, "a")) : undefined,
          b: c.kind !== "removed" ? normalized.locate("b", r.key, pathOn(c, "b")) : undefined,
        });
    }
    return out;
  });
  const semLines = $derived(normalized && { a: lineStarts(normalized.a), b: lineStarts(normalized.b) });

  /** The changes inside a chunk of the semantic view, split into parts with an arrow each. */
  function semanticParts(chunk: Chunk): Part<ApplyItem>[] {
    if (!semLines) return [];
    const hit = (s: SourceRange | undefined, from: number, to: number) => !!s && to > from && s.from < to && s.to > from;
    const rel = (side: Side, pos: number, start: number) => Math.max(0, lineOf(semLines[side], pos) - lineOf(semLines[side], start));
    const list: PartItem<ApplyItem>[] = [];
    for (const it of semItems) {
      const inA = hit(it.a, chunk.fromA, chunk.toA), inB = hit(it.b, chunk.fromB, chunk.toB);
      if (!inA && !inB) continue;
      list.push({
        item: it.item,
        group: it.group,
        a: inA ? rel("a", it.a!.from, chunk.fromA) : undefined,
        b: inB ? rel("b", it.b!.from, chunk.fromB) : undefined,
      });
    }
    return splitChunk(list);
  }

  /** Arrow in the semantic view: apply the changes of that part of the chunk. */
  async function onSemanticArrow(chunk: Chunk, dir: Direction, part: number) {
    const parts = semanticParts(chunk);
    const items = parts[part]?.items;
    if (!items?.length) return;
    if (parts.length === 1 && items.length === 1 && (await applyLines(chunk, dir, items[0]))) return;
    apply(items, dir);
  }

  /**
   * A chunk inside one multi-line string (e.g. a config under `key: |`):
   * copy just its lines, not the whole value. Done like an edit of the
   * normalized text, which is carried over to the source file.
   * Returns false when the chunk is not like that (apply the whole change then).
   */
  async function applyLines(chunk: Chunk, dir: Direction, { resource: r, change: c }: ApplyItem): Promise<boolean> {
    if (!normalized || !semLines || !c || !r.a || !r.b || timer || semTimer) return false;
    if (c.kind !== "changed" || typeof c.a !== "string" || typeof c.b !== "string" || !(isMultiline(c.a) || isMultiline(c.b))) return false;
    // Strictly below the key line, within the value, on both sides.
    const inside = (side: Side, from: number, to: number) => {
      const span = normalized!.locate(side, r.key, pathOn(c, side));
      if (!span) return false;
      const keyLineEnd = normalized![side].indexOf("\n", span.from);
      return keyLineEnd >= 0 && from > keyLineEnd && lineOf(semLines![side], Math.max(from, to - 1)) <= lineOf(semLines![side], span.to);
    };
    if (!inside("a", chunk.fromA, chunk.toA) || !inside("b", chunk.fromB, chunk.toB)) return false;

    const target: Side = dir === "a-to-b" ? "b" : "a";
    if (await refuseRendered(target)) return true;
    const oldNorm = normalized[target];
    const newNorm = dir === "a-to-b"
      ? copyChunkText(normalized.a, chunk.fromA, chunk.toA, oldNorm, chunk.fromB, chunk.toB)
      : copyChunkText(normalized.b, chunk.fromB, chunk.toB, oldNorm, chunk.fromA, chunk.toA);
    const before = raw.getDoc(target);
    const span = normalized.locate(target, r.key, pathOn(c, target))!;
    const lineInValue = lineOf(semLines[target], target === "a" ? chunk.fromA : chunk.fromB) - lineOf(semLines[target], span.from);
    const plan = planSemanticEdit(normalized.encode(target, oldNorm), normalized.encode(target, newNorm), before, opts);
    if (plan.parseError || plan.errors.length || !plan.edits.length) return false;
    raw.applyEdits(target, plan.edits);
    const after = raw.getDoc(target);
    if (after !== before) {
      const res = r[target]!;
      record({
        rel: entries[current]?.rel ?? "", side: target, before, after,
        label: `${dir === "a-to-b" ? "→" : "←"} ${shortPath(c.path)} (${t("someLines")})`,
        touched: [{ key: res.key, path: pathOn(c, target) }],
        lineInValue,
      });
    }
    recompute();
    return true;
  }

  const semSubArrows = (chunk: Chunk) => semanticParts(chunk).slice(1).map(({ side, line }) => ({ side, line }));

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
      case "settings": openSettings(); break;
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
      case "format": {
        // Like Save: the focused side, else the last edited one, else every side with text.
        const e = entries[current];
        const side = (mode === "text" ? raw : sem).focusedSide() ?? lastSide;
        if (side) {
          if (e?.[side] && !e[side]!.readonly) formatSide(side, true);
        } else for (const s of ["a", "b"] as const) if (e?.[s] && !e[s]!.readonly) formatSide(s, true);
        break;
      }
      case "newTab": newTab(); break;
      case "closeTab": void closeTab(); break;
      case "nextTab": switchTab((tabIndex + 1) % tabs.length); break;
      case "prevTab": switchTab((tabIndex - 1 + tabs.length) % tabs.length); break;
      case "filter": {
        // Files first (folder mode), then the list of changes on the second press.
        sidebar = true;
        const files = dirMode && !layout.collapsed.files && !fileList?.filterFocused();
        if (files) fileList?.focusFilter();
        else {
          layout.collapsed.changes = false;
          tick().then(() => resourceList?.focusFilter());
        }
        break;
      }
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
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return; // undo inside a filter field
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
        if (!merge && anyTabDirty()) {
          ev.preventDefault();
          const ok = await ask(t("quitAnyway"), { title: t("unsavedTitle"), kind: "warning" });
          if (ok) await win.destroy();
          return;
        }
        if (merge) {
          // git mergetool reads the exit code: 0 = merged, anything else = leave the file unmerged.
          ev.preventDefault();
          if (merge.saved && !anyDirty()) return exitApp(0);
          const ok = await ask(merge.saved ? t("quitAnyway") : t("mergeQuitUnmerged"), { title: t("unsavedTitle"), kind: "warning" });
          if (ok) await exitApp(merge.saved ? 0 : 1);
          return;
        }
        if (!anyDirty()) return;
        ev.preventDefault();
        const ok = await ask(t("quitAnyway"), { title: t("unsavedTitle"), kind: "warning" });
        if (ok) await win.destroy();
      }),
    );

    // Files edited elsewhere (an editor, git pull…): check on return to the window and every 2 s while focused.
    unlisten.push(win.onFocusChanged(({ payload }) => void (payload && checkDisk(true))));
    const poll = setInterval(() => document.hasFocus() && checkDisk(false), 2000);

    mergeArgs().then(async (m) => {
      if (m) return startMerge(m);
      // Not while git waits for a merge, not in development builds.
      if (settings.autoUpdate && !import.meta.env.DEV) setTimeout(() => void checkUpdates(), 3000);
      const [a, b] = await initialPaths();
      if (a || b) {
        // Started with paths (git difftool, a script): just those, leave the saved session alone.
        if (a) await openPath("a", a);
        if (b) await openPath("b", b);
        return;
      }
      if (settings.restoreSession) await restoreSession();
      sessionOn = true;
    });

    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      unlisten.forEach((u) => u.then((f) => f()));
    };
  });
</script>

<svelte:window onkeydowncapture={onhotkey} onkeydown={onkey} onpaste={onpaste} />

<!-- While Settings is open, the app behind the modal keeps neither focus nor clicks. -->
<main inert={settingsOpen}>
  <!-- The top bar doubles as the window's title bar. Its left part is the
       sidebar's own header strip: the traffic lights (macOS) at its left end,
       the panel's tools at its right end, the handle always on the boundary.
       Collapsing the panel takes the whole strip with it — only the handle
       (and the lights zone) remains, so the stub never grows. -->
  <nav class="tabsbar" aria-label={t("tabs")} data-tauri-drag-region>
    <div class="head" data-tauri-drag-region style="width: {headWidth}px">
      <div class="lights-pad" data-tauri-drag-region style="width: {isMac ? 70 : 0}px"></div>
      <div class="head-drag" data-tauri-drag-region></div>
      {#if sidebar && !merge}
        <button class="head-star" onclick={openFavMenu} title={t("favorites")}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </button>
      {/if}
      {#if sidebar}
        <button class="head-gear" onclick={openSettings} title={t("settings") + hk("settings")}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      {/if}
      <button class="handle" onclick={() => (sidebar = !sidebar)} title={t("toggleSidebar") + hk("toggleSidebar")}>
        {#if sidebar}
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
            <line x1="6" y1="2.75" x2="6" y2="13.25" />
            <path d="M11.7 6.3 9.9 8l1.8 1.7" />
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
            <line x1="6" y1="2.75" x2="6" y2="13.25" />
            <path d="M9.5 6.3 11.3 8l-1.8 1.7" />
          </svg>
        {/if}
      </button>
    </div>
    {#if !merge}
      <div class="tabs">
        {#each tabs as tb, i (tb.id)}
          {@const live = tabOf(i)}
          <div class="tab" class:on={i === tabIndex} role="tab" tabindex="-1" aria-selected={i === tabIndex}
            onmousedown={(e) => { if (e.button === 1) { e.preventDefault(); void closeTab(i); } }}>
            <button class="tab-name" onclick={() => switchTab(i)}
              title={[live.sources.a?.path, live.sources.b?.path].filter(Boolean).join("\n") || t("newTab")}>
              {tabTitle(live)}{tabDirty(live) ? " ✎" : ""}
            </button>
            <button class="tab-close" onclick={() => closeTab(i)} title={t("closeTab") + hk("closeTab")}>×</button>
          </div>
        {/each}
        <button class="tab-new" onclick={newTab} title={t("newTab") + hk("newTab")}>+</button>
      </div>
    {/if}
    <span class="drag" data-tauri-drag-region></span>
    {#if winControls}
      <div class="wc">
        <button title={t("winMin")} onclick={() => void getCurrentWindow().minimize()}>—</button>
        <button title={t("winMax")} onclick={() => void getCurrentWindow().toggleMaximize()}>▢</button>
        <button class="close" title={t("winClose")} onclick={() => void getCurrentWindow().close()}>✕</button>
      </div>
    {/if}
  </nav>
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
        {#if merge}
          <Section title={t("conflicts")} badge={merge.conflicts.length} collapsed={false} ontoggle={() => {}} style="flex: none; max-height: 45%">
            <ConflictList conflicts={merge.conflicts} choice={merge.choice} applied={merge.applied} onpick={pickConflict} onselect={onconflict} />
          </Section>
        {/if}
        <Section title={t("changes")} badge={result ? result.resources.reduce((n, r) => n + (r.status === "equal" ? 0 : r.changes.length || 1), 0) : ""}
          collapsed={c.changes} ontoggle={() => toggle("changes")} style={paneStyle("changes", 0)}>
          <ResourceList bind:this={resourceList} {result} {onresource} onchange={onchangeClick} {onedit} onapply={apply} />
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
            {#if merge && side === "a"}
              <div class="segmented" role="tablist" title={t("mergeTitle")}>
                {#each [["theirs", "mergeTheirs", "mergeTheirsTitle"], ["ours", "mergeOurs", "mergeOursTitle"], ["base", "mergeBase", "mergeBaseTitle"]] as const as [id, label, title]}
                  <button class:on={merge.show === id} onclick={() => showInMerge(id)} title={t(title)}>{t(label)}</button>
                {/each}
              </div>
            {:else if merge}
              <span class="role" title={t("mergeResultTitle")}>{t("mergeResult")}</span>
            {:else}
            <div class="open">
              <button onclick={() => pick(side, false)} title={side === "a" ? t("openFileLeft") + hk("openFileLeft") : t("openFileRight") + hk("openFileRight")}>{t("openFile")}</button>
              <button onclick={() => pick(side, true)} title={side === "a" ? t("openFolderLeft") + hk("openFolderLeft") : t("openFolderRight") + hk("openFolderRight")}>{t("openFolder")}</button>
            </div>
            {/if}
            <span class="path" title={!src && buf ? t("pastedTitle") : src?.kind === "render" ? `${renderLabel(src)}\n${src.path}` : buf?.path ?? src?.path ?? ""}>
              {#if !src && buf}
                <b>{t("pasted")}{isDirty(buf) ? " ✎" : ""}</b>
                <small>{t("pastedHint")}</small>
              {:else if !src}
                <i>{t("dropHere")}</i>
              {:else if dirMode}
                <b>{entry ? entry.rel : "—"}{isDirty(buf) ? " ✎" : ""}{entry && !buf ? ` ${t("missing")}` : ""}</b>
                <small>{src.path}</small>
              {:else if src.kind === "render"}
                <b>{baseName(src.path)}</b>
                <small><span class="tool">{renderLabel(src)}</span> · {src.path}</small>
              {:else}
                <b>{baseName(src.path)}{isDirty(buf) ? " ✎" : ""}</b>
                <small>{src.path}</small>
              {/if}
            </span>
            {#if kindBadge(side)}<span class="badge" title={kindBadge(side)}>{kindBadge(side)}</span>{/if}
            {#if src?.kind === "render"}
              <button onclick={() => rerender(side)} title={t("rerender")}>↻</button>
            {/if}
            <button onclick={() => formatSide(side)} disabled={!buf || buf.readonly} title={t("formatTitle") + hk("format")}>{t("format")}</button>
            <button onclick={() => alignSide(side)} disabled={!buf || buf.readonly || !entry?.[otherSide(side)]}
              title={side === "a" ? t("alignTitleRight") : t("alignTitleLeft")}>{t("align")}</button>
            <button onclick={() => save(side)} disabled={!isDirty(buf)} title={t("saveTitle") + hk("save")}>{t("save")}</button>
          </div>
        {/each}
      </header>

      <div class="views">
        {#if startScreen}
          <div class="start">
            <p class="start-hint">{t("startHint")}</p>
            <p class="start-paste">{t("pasteHint", { key: formatCombo("Mod+V") })}</p>
            {#if favorites.length}
              <h3>{t("favorites")}</h3>
              <ul>
                {#each favorites as item (favKey(item))}
                  <li>
                    <button class="recent" onclick={() => void openFavorite(item)} title={`${item.a.path}\n${item.b.path}`}>
                      <b>{item.name}</b>
                      <small>{item.a.path} ↔ {item.b.path}</small>
                    </button>
                    <button class="recent-x" onclick={() => (favorites = removeFavorite(favorites, item))} title={t("favRemove")}>×</button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if recent.length}
              <h3>{t("recentTitle")}</h3>
              <ul>
                {#each recent as r (r.at)}
                  <li>
                    <button class="recent" onclick={() => openRecent(r)} title={`${r.a.path}\n${r.b.path}`}>
                      <b>{pairTitle(r.a, r.b, "")}</b>
                      <small>{r.a.path} ↔ {r.b.path}</small>
                    </button>
                    <button class="recent-x" onclick={() => (recent = removeRecent(recent, r))} title={t("recentRemove")}>×</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
        <div class="view" class:hidden={mode !== "text"}>
          <DiffView bind:this={raw} {theme} {collapse} single={singleDoc} onarrow={onTextArrow} onchange={onRawChange} ontx={onRawTx}
            onchunks={(n) => (chunks = n)} markers={rawMarkers} {onmarker} />
        </div>
        <div class="view" class:hidden={mode !== "semantic"}>
          <DiffView bind:this={sem} {theme} {collapse} single={singleDoc} onarrow={onSemanticArrow} subArrows={semSubArrows} onuseredit={onSemanticUserEdit}
            markers={semMarkers} {onmarker} />
        </div>
      </div>
    </section>
  </div>

  <footer>
    <div class="segmented" role="tablist">
      <button class:on={mode === "semantic"} onclick={() => setMode("semantic")} title={t("semanticTitle") + hk("modeSemantic")}>{t("semantic")}</button>
      <button class:on={mode === "text"} onclick={() => setMode("text")} title={t("sourceTitle") + hk("modeSource")}>{t("source")}</button>
    </div>
    {#if singleDoc}
      <span class="hint">{t("docHint")}</span>
    {:else if mode === "text"}
      <span>{tn("differences", chunks)}</span>
    {:else}
      <span>{t("resourcesDiffer", { n: changedCount, total: result?.resources.length ?? 0 })}</span>
    {/if}
    <button onclick={() => active().jump(-1)} title={t("prevDiff") + hk("prevDiff")}>↑</button>
    <button onclick={() => active().jump(1)} title={t("nextDiff") + hk("nextDiff")}>↓</button>
    {#if mode === "semantic"}
      {#if semError}
        <span class="error" title={semError}>{semError}</span>
      {:else if merge}
        <span class="hint">{t("mergeHint")}</span>
      {:else if entry?.a?.readonly || entry?.b?.readonly}
        <span class="hint">{t("renderedHint")}</span>
      {:else}
        <span class="hint">{t("semanticHint", { key: formatCombo(settings.hotkeys.showInSource) })}</span>
      {/if}
    {/if}
    <span class="spacer"></span>
    {#if update}
      <button class="update" onclick={offerUpdate} title={t("updateAvailableTitle", { v: update.version })}>⬆ {t("updateAvailable", { v: update.version })}</button>
    {/if}
    {#if project}
      <span class="project" class:bad={project.errors.length > 0}
        title={`${t("projectConfigTitle")}\n${project.path}${project.errors.length ? "\n\n" + project.errors.join("\n") : ""}`}>⚑ {CONFIG_NAME}</span>
    {/if}
    {#if notice}<span class="notice" title={notice}>{notice}</span>{/if}
    {#if merge}
      <button class="finish" onclick={finishMerge} title={t("mergeFinishTitle")}>✓ {t("mergeFinish")}</button>
    {/if}
    {#if dirMode}
      <button onclick={saveAll} disabled={!anyDirty()} title={t("saveAllTitle") + hk("saveAll")}>{t("saveAll")}</button>
    {/if}
    <label><input type="checkbox" bind:checked={collapse} /> {t("collapseUnchanged")}</label>
  </footer>
</main>

{#if settingsOpen}
  <Settings bind:tab={settingsTab} project={project?.path} onclearrecent={() => (recent = clearRecent())} oncheckupdate={() => checkUpdates(true)} onclose={closeSettings} />
{/if}

{#if favMenu}
  <!-- The favorites menu: anchored under the star, closed by a click away. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="menu-backdrop" onclick={() => (favMenu = null)}></div>
  <div class="menu" role="menu" tabindex="-1" aria-label={t("favorites")} style="left: {favMenu.x}px; top: {favMenu.y}px" onkeydown={onFavKey}>
    {#if favForm}
      <label class="menu-form">
        <input bind:value={favName} placeholder={favDefaultName} spellcheck="false" use:autofocus
          onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveFavorite(); } }} />
        <button onclick={saveFavorite} disabled={!canFav}>{t("save")}</button>
        <button onclick={() => (favForm = false)}>{t("favCancel")}</button>
      </label>
    {:else}
      {#if favorites.length}
        {#each favorites as item (favKey(item))}
          <div class="menu-row">
            <button class="menu-item" onclick={() => void openFavorite(item)} title={`${item.a.path}\n${item.b.path}`}>
              <b>{item.name}</b>
              <small>{item.a.path} ↔ {item.b.path}</small>
            </button>
            <button class="menu-x" onclick={() => (favorites = removeFavorite(favorites, item))} title={t("favRemove")}>×</button>
          </div>
        {/each}
      {:else}
        <p class="menu-empty">{t("favEmpty")}</p>
      {/if}
      <button class="menu-add" disabled={!canFav} title={canFav ? "" : t("favNeedPair")}
        onclick={() => { favName = favDefaultName; favForm = true; }}>
        {t("favAdd")}
      </button>
    {/if}
  </div>
{/if}

<style>
  main { display: flex; flex-direction: column; height: 100vh; }
  .tabsbar { flex: none; display: flex; align-items: stretch; height: 40px; background: var(--bg); border-bottom: 1px solid var(--border); }
  .head { flex: none; display: flex; align-items: stretch; background: var(--panel); border-right: 1px solid var(--border);
    transition: width .14s ease; overflow: hidden; }
  .head-drag { flex: 1; min-width: 0; }
  .head-star, .head-gear, .handle { all: unset; cursor: default; flex: none; width: 40px; display: flex; align-items: center;
    justify-content: center; color: var(--muted); }
  .head-star:hover, .head-gear:hover, .handle:hover { color: var(--text); background: var(--hover); }
  .drag { flex: 1; min-width: 12px; }
  .wc { display: flex; flex: none; }
  .wc button { all: unset; cursor: default; width: 46px; text-align: center; line-height: 40px; color: var(--muted); font-size: 14px; }
  .wc button:hover { background: var(--hover); color: var(--text); }
  .wc button.close:hover { background: #e81123; color: white; }
  .tabs { flex: 0 1 auto; min-width: 0; display: flex; align-items: stretch; gap: 1px; background: var(--border); overflow-x: auto; scrollbar-width: none; }
  .tab { display: flex; align-items: center; min-width: 0; max-width: 260px; background: var(--bg); color: var(--muted); }
  .tab.on { background: var(--panel); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .tab-name { all: unset; cursor: default; padding: 0 4px 0 13px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-close { all: unset; cursor: default; padding: 0 9px; opacity: 0; font-size: 15px; }
  .tab:hover .tab-close, .tab.on .tab-close { opacity: 0.7; }
  .tab-close:hover { opacity: 1 !important; color: var(--text); }
  .tab-new { all: unset; cursor: default; padding: 0 14px; background: var(--bg); color: var(--muted); font-size: 19px; }
  .tab-new:hover { color: var(--text); }
  .start { position: absolute; z-index: 5; inset: 0; overflow-y: auto; padding: 24px 32px; background: var(--bg); }
  .start-hint { color: var(--muted); margin: 0 0 16px; }
  .start-paste { margin: 0 0 20px; padding: 8px 12px; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); max-width: max-content; }
  .menu-backdrop { position: fixed; inset: 0; z-index: 50; }
  .menu { position: fixed; z-index: 51; min-width: 280px; max-width: 420px; padding: 4px; background: var(--bg);
    border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 12px 40px #0005; font-size: 12px; }
  .menu-row { display: flex; align-items: stretch; }
  .menu-item { all: unset; cursor: default; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;
    padding: 6px 10px; border-radius: var(--radius); }
  .menu-item:hover { background: var(--hover); }
  .menu-item small { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-x { all: unset; cursor: default; padding: 0 10px; opacity: 0; color: var(--muted); }
  .menu-row:hover .menu-x { opacity: 1; }
  .menu-x:hover { color: var(--text); }
  .menu-add { all: unset; cursor: default; display: block; width: 100%; padding: 6px 10px; text-align: left;
    color: var(--accent); border-radius: var(--radius); }
  .menu-add:hover:not(:disabled) { background: var(--hover); }
  .menu-add:disabled { color: var(--muted); }
  .menu-empty { margin: 8px 10px; color: var(--muted); }
  .menu-form { display: flex; gap: 4px; }
  .menu-form input { flex: 1; min-width: 0; }
  .start h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .start ul { list-style: none; margin: 0; padding: 0; max-width: 900px; }
  .start li { display: flex; align-items: center; border-radius: 6px; }
  .start li:hover { background: var(--hover); }
  .recent { all: unset; cursor: default; flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 6px 10px; }
  .recent b, .recent small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent small { color: var(--muted); font-size: 11px; }
  .recent-x { all: unset; cursor: default; padding: 0 10px; color: var(--muted); opacity: 0; }
  .start li:hover .recent-x { opacity: 1; }
  .body { flex: 1; min-height: 0; display: flex; }
  aside { flex: none; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--border); min-height: 0; overflow: hidden; }
  .work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .views { flex: 1; min-height: 0; display: flex; position: relative; }
  .view { flex: 1; min-width: 0; display: flex; }
  .view.hidden { display: none; }
  header { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .pane { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 6px 10px; background: var(--panel); min-width: 0; transition: background 0.1s;
    container-type: inline-size; }
  .pane > :global(*) { flex: none; }
  .pane > .path { flex: 1 1 120px; }
  /* Narrow pane: the file name gets its own line above the buttons instead of being squeezed to nothing. */
  @container (max-width: 560px) {
    .pane > .path { order: -1; flex-basis: 100%; }
  }
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
  .tool { font-weight: 400; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--accent); }
  .notice { color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 40%; }
  .spacer { flex: 1; }
  .update { flex: none; background: var(--added); color: var(--accent-text); border-color: var(--added); }
  .project { flex: none; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--accent); }
  .project.bad { color: var(--changed); }
  label { display: flex; align-items: center; gap: 4px; }
  .segmented { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; flex: none; }
  .segmented button { all: unset; padding: 2px 10px; cursor: default; }
  .segmented button + button { border-left: 1px solid var(--border); }
  .segmented button.on { background: var(--accent); color: var(--accent-text); }
  .role { flex: none; font-weight: 600; color: var(--accent); }
  .finish { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
</style>
