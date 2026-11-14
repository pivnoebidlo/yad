<script lang="ts">
  import { onMount, tick } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open, ask, message } from "@tauri-apps/plugin-dialog";
  import DiffView from "./lib/DiffView.svelte";
  import ResourceList from "./lib/ResourceList.svelte";
  import { readText, writeText, initialPaths, baseName, type Side } from "./lib/files";
  import {
    compareTexts, defaultOptions, locatePath, renderNormalized,
    type Change, type CompareResult, type NormalizedView, type ResourceDiff, type SourceRange,
  } from "./lib/semantic";

  type Pane = { path: string | null; saved: string; dirty: boolean };
  type Mode = "text" | "semantic";
  type Span = { from: number; to: number };

  let raw: DiffView;
  let sem: DiffView;
  let work: HTMLElement;
  let panes = $state<Record<Side, Pane>>({
    a: { path: null, saved: "", dirty: false },
    b: { path: null, saved: "", dirty: false },
  });
  let mode = $state<Mode>("semantic");
  let sidebar = $state(true);
  let chunks = $state(0);
  let revert = $state<"a-to-b" | "b-to-a">("a-to-b");
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
    if (!panes.a.path && !panes.b.path) return;
    result = compareTexts(raw.getDoc("a"), raw.getDoc("b"), opts);
    normalized = renderNormalized(result.resources, opts);
    sem.setDoc("a", normalized.a, "normalized.yaml");
    sem.setDoc("b", normalized.b, "normalized.yaml");
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(recompute, 200);
  }

  async function setMode(m: Mode) {
    if (m === "semantic" && timer) recompute();
    mode = m;
    await tick();
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

  const active = () => (mode === "text" ? raw : sem);

  // ---- files --------------------------------------------------------------

  async function load(side: Side, path: string) {
    if (panes[side].dirty && !(await confirmDiscard(side))) return;
    try {
      const text = await readText(path);
      panes[side] = { path, saved: text, dirty: false };
      raw.setDoc(side, text, path);
      schedule();
    } catch (e) {
      await message(String(e), { title: "Cannot open file", kind: "error" });
    }
  }

  async function pick(side: Side) {
    const path = await open({ multiple: false, directory: false, filters });
    if (typeof path === "string") await load(side, path);
  }

  async function save(side: Side) {
    const pane = panes[side];
    if (!pane.path || !pane.dirty) return;
    const text = raw.getDoc(side);
    try {
      await writeText(pane.path, text);
      pane.saved = text;
      pane.dirty = false;
    } catch (e) {
      await message(String(e), { title: "Cannot save file", kind: "error" });
    }
  }

  function confirmDiscard(side: Side) {
    const name = panes[side].path ? baseName(panes[side].path!) : "untitled";
    return ask(`Discard unsaved changes in ${name}?`, { title: "Unsaved changes", kind: "warning" });
  }

  function onRawChange(side: Side, text: string) {
    panes[side].dirty = text !== panes[side].saved;
    schedule();
  }

  function onkey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "s") {
      e.preventDefault();
      const side = mode === "text" ? raw.focusedSide() : null;
      if (e.shiftKey || !side) { save("a"); save("b"); } else save(side);
    } else if (mod && e.key === "o") {
      e.preventDefault();
      pick(e.shiftKey ? "b" : "a");
    } else if (mod && (e.key === "1" || e.key === "2")) {
      e.preventDefault();
      setMode(e.key === "1" ? "text" : "semantic");
    } else if (mod && e.key === "b") {
      e.preventDefault();
      sidebar = !sidebar;
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active().jump(e.key === "ArrowDown" ? 1 : -1);
    }
  }

  onMount(() => {
    const unlisten: Array<Promise<() => void>> = [];

    // Drop on the left/right half of the diff area; two files at once fill both sides.
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
          if (p.paths.length >= 2) { load("a", p.paths[0]); load("b", p.paths[1]); }
          else if (p.paths.length === 1) load(sideAt(p.position.x), p.paths[0]);
        }
      }),
    );

    const win = getCurrentWindow();
    unlisten.push(
      win.onCloseRequested(async (ev) => {
        if (!panes.a.dirty && !panes.b.dirty) return;
        ev.preventDefault();
        const ok = await ask("There are unsaved changes. Quit anyway?", { title: "Unsaved changes", kind: "warning" });
        if (ok) await win.destroy();
      }),
    );

    initialPaths().then(([a, b]) => {
      if (a) load("a", a);
      if (b) load("b", b);
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
        <ResourceList {result} {onresource} onchange={onchangeClick} {onedit} />
      </aside>
    {/if}

    <section class="work" bind:this={work}>
      <header>
        {#each ["a", "b"] as const as side}
          <div class="pane" class:drop={dropTarget === side}>
            <button onclick={() => pick(side)} title={side === "a" ? "Open left (⌘O)" : "Open right (⇧⌘O)"}>Open…</button>
            <span class="path" title={panes[side].path ?? ""}>
              {#if panes[side].path}
                <b>{baseName(panes[side].path!)}{panes[side].dirty ? " •" : ""}</b>
                <small>{panes[side].path}</small>
              {:else}
                <i>Drop a file here or click Open</i>
              {/if}
            </span>
            <button onclick={() => save(side)} disabled={!panes[side].dirty} title="Save (⌘S)">Save</button>
          </div>
        {/each}
      </header>

      <div class="views">
        <div class="view" class:hidden={mode !== "text"}>
          <DiffView bind:this={raw} {dark} {revert} {collapse} onchange={onRawChange} onchunks={(n) => (chunks = n)} />
        </div>
        <div class="view" class:hidden={mode !== "semantic"}>
          <DiffView bind:this={sem} {dark} collapse={collapse} readonly />
        </div>
      </div>
    </section>
  </div>

  <footer>
    <button class="toggle" class:on={sidebar} onclick={() => (sidebar = !sidebar)} title="Toggle changes panel (⌘B)">☰</button>
    <div class="segmented" role="tablist">
      <button class:on={mode === "text"} onclick={() => setMode("text")} title="Original files, editable (⌘1)">Text</button>
      <button class:on={mode === "semantic"} onclick={() => setMode("semantic")} title="Normalized, noise hidden (⌘2)">Semantic</button>
    </div>
    {#if mode === "text"}
      <span>{chunks} {chunks === 1 ? "text difference" : "text differences"}</span>
    {:else}
      <span>{changedCount} of {result?.resources.length ?? 0} resources differ</span>
    {/if}
    <button onclick={() => active().jump(-1)} title="Previous (⌥↑)">↑</button>
    <button onclick={() => active().jump(1)} title="Next (⌥↓)">↓</button>
    <span class="spacer"></span>
    <label><input type="checkbox" bind:checked={collapse} /> Collapse unchanged</label>
    {#if mode === "text"}
      <label>
        Copy
        <select bind:value={revert}>
          <option value="a-to-b">left → right</option>
          <option value="b-to-a">right → left</option>
        </select>
      </label>
    {/if}
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
  .path { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
  .path b, .path small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path small, .path i { color: var(--muted); font-size: 11px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--panel); border-top: 1px solid var(--border); font-size: 12px; }
  .spacer { flex: 1; }
  label { display: flex; align-items: center; gap: 4px; }
  .segmented { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .segmented button { all: unset; padding: 2px 10px; cursor: default; }
  .segmented button + button { border-left: 1px solid var(--border); }
  .segmented button.on, .toggle.on { background: var(--accent); color: white; }
  .toggle { padding: 2px 8px; }
</style>
