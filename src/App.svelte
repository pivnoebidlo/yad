<script lang="ts">
  import { onMount, tick } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open, ask, message } from "@tauri-apps/plugin-dialog";
  import type { Chunk } from "@codemirror/merge";
  import DiffView from "./lib/DiffView.svelte";
  import ResourceList from "./lib/ResourceList.svelte";
  import FileList from "./lib/FileList.svelte";
  import {
    readText, writeText, initialPaths, baseName, pathKind, listFiles, joinPath, type Side,
  } from "./lib/files";
  import { isDirty, otherSide, statusOf, type Buf, type Entry } from "./lib/workspace";
  import {
    compareTexts, defaultOptions, formatPath, locatePath, planApply, renderNormalized,
    type ApplyItem, type Change, type CompareResult, type Direction, type NormalizedView,
    type ResourceDiff, type SourceRange,
  } from "./lib/semantic";

  type Mode = "text" | "semantic";
  type Span = { from: number; to: number };
  type Source = { kind: "file" | "dir"; path: string };

  let raw: DiffView;
  let sem: DiffView;
  let work: HTMLElement;

  // ---- workspace: two files, or two directories with many file pairs --------
  let sources = $state<Record<Side, Source | null>>({ a: null, b: null });
  let entries = $state<Entry[]>([]);
  let current = $state(-1);
  const dirMode = $derived(sources.a?.kind === "dir" || sources.b?.kind === "dir");
  const entry = $derived<Entry | undefined>(entries[current]);
  const anyDirty = () => entries.some((e) => isDirty(e.a) || isDirty(e.b));

  let mode = $state<Mode>("semantic");
  let sidebar = $state(true);
  let chunks = $state(0);
  let collapse = $state(false);
  let dropTarget = $state<Side | null>(null);

  // Semantic state. `$state.raw`: results hold yaml nodes, which must not be proxied.
  const opts = defaultOptions();
  let result = $state.raw<CompareResult | null>(null);
  let normalized: NormalizedView | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let dark = $state(darkQuery.matches);
  darkQuery.addEventListener("change", (e) => (dark = e.matches));

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
      sem.setDoc("a", "", null);
      sem.setDoc("b", "", null);
      return;
    }
    result = compareTexts(raw.getDoc("a"), raw.getDoc("b"), opts);
    normalized = renderNormalized(result.resources, opts);
    sem.setDoc("a", normalized.a, "normalized.yaml");
    sem.setDoc("b", normalized.b, "normalized.yaml");
    e.status = statusOf(e, result);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(recompute, 200);
  }

  async function setMode(m: Mode) {
    if (timer) recompute();
    mode = m;
    await tick();
  }

  // ---- loading ------------------------------------------------------------

  function confirmDiscard(side: Side) {
    if (!entries.some((e) => isDirty(e[side]))) return Promise.resolve(true);
    const what = side === "a" ? "left" : "right";
    return ask(`Discard unsaved changes on the ${what} side?`, { title: "Unsaved changes", kind: "warning" });
  }

  async function openPath(side: Side, path: string) {
    const kind = await pathKind(path);
    if (kind === "missing") return message(`${path} does not exist`, { title: "Cannot open", kind: "error" });
    if (!(await confirmDiscard(side))) return;

    // A folder on one side and a file on the other cannot be compared: reset the other side.
    const other = otherSide(side);
    if (sources[other] && sources[other]!.kind !== kind) {
      if (!(await confirmDiscard(other))) return;
      sources[other] = null;
      entries = [];
    }
    try {
      if (kind === "file") await loadFile(side, path);
      else await loadDir(side, path);
      sources[side] = { kind, path };
    } catch (e) {
      return message(String(e), { title: "Cannot open", kind: "error" });
    }
    const keep = entries[current]?.rel;
    let i = entries.findIndex((e) => e.rel === keep);
    if (i < 0) i = entries.findIndex((e) => e.status !== "equal" && e.status !== "reordered");
    selectEntry(Math.max(0, Math.min(i, entries.length - 1)));
  }

  async function loadFile(side: Side, path: string) {
    const text = await readText(path);
    const buf: Buf = { path, saved: text, text, exists: true };
    const e = entries.length === 1 && entries[0].rel === "" ? entries[0] : { rel: "", status: "equal" as const };
    e[side] = buf;
    e.status = statusOf(e);
    entries = [e];
  }

  async function loadDir(side: Side, root: string) {
    const rels = await listFiles(root);
    const texts = await Promise.all(rels.map((rel) => readText(joinPath(root, rel)).catch(() => null)));
    const byRel = new Map<string, Entry>();
    for (const e of entries) {
      if (e.rel === "") continue;
      delete e[side];
      byRel.set(e.rel, e);
    }
    rels.forEach((rel, i) => {
      const text = texts[i];
      if (text === null) return;
      const e = byRel.get(rel) ?? { rel, status: "equal" };
      e[side] = { path: joinPath(root, rel), saved: text, text, exists: true };
      byRel.set(rel, e);
    });
    entries = [...byRel.values()]
      .filter((e) => e.a || e.b)
      .sort((x, y) => (x.rel < y.rel ? -1 : 1))
      .map((e) => ({ ...e, status: statusOf(e) }));
  }

  function selectEntry(i: number) {
    current = i;
    const e = entries[i];
    for (const side of ["a", "b"] as const) raw.setDoc(side, e?.[side]?.text ?? "", e?.[side]?.path ?? e?.rel ?? null);
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
    const buf = e[side];
    if (buf) buf.text = text;
    else if (text !== "" && sources[side]?.kind === "dir") {
      // Typing into a file that exists only on the other side creates it here.
      e[side] = { path: joinPath(sources[side]!.path, e.rel), saved: "", text, exists: false };
    }
    schedule();
  }

  async function saveBuf(buf: Buf) {
    try {
      await writeText(buf.path, buf.text);
      buf.saved = buf.text;
      buf.exists = true;
    } catch (e) {
      await message(String(e), { title: "Cannot save file", kind: "error" });
    }
  }

  async function save(side: Side) {
    const buf = entries[current]?.[side];
    if (isDirty(buf)) await saveBuf(buf!);
  }

  async function saveAll() {
    for (const e of entries) for (const buf of [e.a, e.b]) if (isDirty(buf)) await saveBuf(buf!);
  }

  /** Copy a whole file over the other side (or create it there). */
  function copyFile(i: number, dir: Direction) {
    const e = entries[i];
    const [s, t]: [Side, Side] = dir === "a-to-b" ? ["a", "b"] : ["b", "a"];
    const src = e[s];
    if (!src) return;
    if (e[t]) e[t]!.text = src.text;
    else if (sources[t]?.kind === "dir") e[t] = { path: joinPath(sources[t]!.path, e.rel), saved: "", text: src.text, exists: false };
    else return;
    if (i === current) raw.setDoc(t, src.text, e[t]!.path);
    else e.status = statusOf(e);
  }

  // ---- applying semantic changes -------------------------------------------

  const changeKey = (r: ResourceDiff, c?: Change) => `${r.key}|${c ? formatPath(c.path) : ""}`;

  async function apply(items: ApplyItem[], dir: Direction) {
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
    const plan = planApply(items, dir, raw.getDoc(target));
    raw.applyEdits(target, plan.edits);
    recompute();
    if (plan.errors.length)
      await message(plan.errors.join("\n"), { title: "Some changes could not be applied", kind: "warning" });
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
        const inA = c.kind !== "added" && hit(normalized.locate("a", r.key, c.path), chunk.fromA, chunk.toA);
        const inB = c.kind !== "removed" && hit(normalized.locate("b", r.key, c.path), chunk.fromB, chunk.toB);
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
      return res && point(locatePath(res.node, c.path, res.ctx));
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
        const l = normalized!.locate(side, r.key, c.path);
        return has ? span(l) : point(l);
      };
      sem.select({ a: loc("a"), b: loc("b") }, c.kind === "removed" ? "a" : "b");
    } else raw.select(sourceSpans(r, c), c.kind === "removed" ? "a" : "b");
  }

  async function onedit(r: ResourceDiff, c: Change) {
    await setMode("text");
    raw.select(sourceSpans(r, c), c.kind === "removed" ? "a" : "b");
  }

  /** Double-click / typing in the read-only semantic view: go to the same place in the source. */
  async function onSemanticJump(side: Side, pos: number) {
    const hit = normalized?.pathAt(side, pos);
    const r = hit && result?.resources.find((x) => x.key === hit.key);
    const s: Side = r?.[side] ? side : otherSide(side);
    const res = r?.[s];
    await setMode("text");
    if (!res || !hit) return;
    raw.select({ [s]: point(locatePath(res.node, hit.path, res.ctx)) }, s);
  }

  const active = () => (mode === "text" ? raw : sem);

  function onkey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      const side = mode === "text" ? raw.focusedSide() : null;
      if (e.shiftKey) saveAll();
      else if (side) save(side);
      else { save("a"); save("b"); }
    } else if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      pick(e.shiftKey ? "b" : "a", e.altKey);
    } else if (mod && (e.key === "1" || e.key === "2")) {
      e.preventDefault();
      setMode(e.key === "1" ? "text" : "semantic");
    } else if (mod && e.key === "b") {
      e.preventDefault();
      sidebar = !sidebar;
    } else if (e.altKey && mod && (e.key === "ArrowDown" || e.key === "ArrowUp") && entries.length > 1) {
      e.preventDefault();
      selectEntry((current + (e.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length);
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active().jump(e.key === "ArrowDown" ? 1 : -1);
    }
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
        const ok = await ask("There are unsaved changes. Quit anyway?", { title: "Unsaved changes", kind: "warning" });
        if (ok) await win.destroy();
      }),
    );

    initialPaths().then(async ([a, b]) => {
      if (a) await openPath("a", a);
      if (b) await openPath("b", b);
    });

    return () => {
      clearTimeout(timer);
      unlisten.forEach((u) => u.then((f) => f()));
    };
  });
</script>

<svelte:window onkeydown={onkey} />

<main>
  <div class="body">
    {#if sidebar}
      <aside>
        {#if dirMode}
          <FileList {entries} {current} onselect={selectEntry} oncopy={copyFile} />
        {/if}
        <ResourceList {result} {onresource} onchange={onchangeClick} {onedit} onapply={apply} />
      </aside>
    {/if}

    <section class="work" bind:this={work}>
      <header>
        {#each ["a", "b"] as const as side}
          {@const src = sources[side]}
          {@const buf = entry?.[side]}
          <div class="pane" class:drop={dropTarget === side}>
            <div class="open">
              <button onclick={() => pick(side, false)} title={side === "a" ? "Open file on the left (⌘O)" : "Open file on the right (⇧⌘O)"}>File…</button>
              <button onclick={() => pick(side, true)} title={side === "a" ? "Open folder on the left (⌥⌘O)" : "Open folder on the right (⌥⇧⌘O)"}>Folder…</button>
            </div>
            <span class="path" title={buf?.path ?? src?.path ?? ""}>
              {#if !src}
                <i>Drop a file or folder here</i>
              {:else if dirMode}
                <b>{entry ? entry.rel : "—"}{isDirty(buf) ? " •" : ""}{entry && !buf ? " (missing)" : ""}</b>
                <small>{src.path}</small>
              {:else}
                <b>{baseName(src.path)}{isDirty(buf) ? " •" : ""}</b>
                <small>{src.path}</small>
              {/if}
            </span>
            <button onclick={() => save(side)} disabled={!isDirty(buf)} title="Save (⌘S), all files: ⇧⌘S">Save</button>
          </div>
        {/each}
      </header>

      <div class="views">
        <div class="view" class:hidden={mode !== "text"}>
          <DiffView bind:this={raw} {dark} {collapse} onchange={onRawChange} onchunks={(n) => (chunks = n)} />
        </div>
        <div class="view" class:hidden={mode !== "semantic"}>
          <DiffView bind:this={sem} {dark} {collapse} readonly onarrow={onSemanticArrow} onjump={onSemanticJump} />
        </div>
      </div>
    </section>
  </div>

  <footer>
    <button class="toggle" class:on={sidebar} onclick={() => (sidebar = !sidebar)} title="Toggle side panel (⌘B)">☰</button>
    <div class="segmented" role="tablist">
      <button class:on={mode === "text"} onclick={() => setMode("text")} title="Original files, editable (⌘1)">Text</button>
      <button class:on={mode === "semantic"} onclick={() => setMode("semantic")} title="Normalized, noise hidden (⌘2)">Semantic</button>
    </div>
    {#if mode === "text"}
      <span>{chunks} {chunks === 1 ? "text difference" : "text differences"}</span>
    {:else}
      <span>{changedCount} of {result?.resources.length ?? 0} resources differ</span>
    {/if}
    <button onclick={() => active().jump(-1)} title="Previous difference (⌥↑)">↑</button>
    <button onclick={() => active().jump(1)} title="Next difference (⌥↓)">↓</button>
    {#if mode === "semantic"}
      <span class="hint">Read-only view · double-click or start typing to edit the source · arrows apply changes</span>
    {/if}
    <span class="spacer"></span>
    {#if dirMode}
      <button onclick={saveAll} disabled={!anyDirty()} title="Save all changed files (⇧⌘S)">Save all</button>
    {/if}
    <label><input type="checkbox" bind:checked={collapse} /> Collapse unchanged</label>
  </footer>
</main>

<style>
  main { display: flex; flex-direction: column; height: 100vh; }
  .body { flex: 1; min-height: 0; display: flex; }
  aside { width: 320px; flex: none; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--border); min-height: 0; }
  .work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .views { flex: 1; min-height: 0; display: flex; }
  .view { flex: 1; min-width: 0; display: flex; }
  .view.hidden { display: none; }
  header { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .pane { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--panel); min-width: 0; transition: background 0.1s; }
  .pane.drop { background: var(--accent-soft); outline: 2px dashed var(--accent); outline-offset: -3px; }
  .open { display: flex; gap: 4px; }
  .path { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
  .path b, .path small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path small, .path i { color: var(--muted); font-size: 11px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--panel); border-top: 1px solid var(--border); font-size: 12px; white-space: nowrap; }
  .hint { color: var(--muted); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .spacer { flex: 1; }
  label { display: flex; align-items: center; gap: 4px; }
  .segmented { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; flex: none; }
  .segmented button { all: unset; padding: 2px 10px; cursor: default; }
  .segmented button + button { border-left: 1px solid var(--border); }
  .segmented button.on, .toggle.on { background: var(--accent); color: white; }
  .toggle { padding: 2px 8px; }
</style>
