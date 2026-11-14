<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open, ask, message } from "@tauri-apps/plugin-dialog";
  import DiffView from "./lib/DiffView.svelte";
  import { readText, writeText, initialPaths, baseName, type Side } from "./lib/files";

  type Pane = { path: string | null; saved: string; dirty: boolean };

  let diff: DiffView;
  let panes = $state<Record<Side, Pane>>({
    a: { path: null, saved: "", dirty: false },
    b: { path: null, saved: "", dirty: false },
  });
  let chunks = $state(0);
  let revert = $state<"a-to-b" | "b-to-a">("a-to-b");
  let collapse = $state(false);
  let dropTarget = $state<Side | null>(null);

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let dark = $state(darkQuery.matches);
  darkQuery.addEventListener("change", (e) => (dark = e.matches));

  const filters = [
    { name: "YAML / JSON", extensions: ["yaml", "yml", "json"] },
    { name: "All files", extensions: ["*"] },
  ];

  async function load(side: Side, path: string) {
    if (panes[side].dirty && !(await confirmDiscard(side))) return;
    try {
      const text = await readText(path);
      panes[side] = { path, saved: text, dirty: false };
      diff.setDoc(side, text, path);
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
    const text = diff.getDoc(side);
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

  function onchange(side: Side, text: string) {
    panes[side].dirty = text !== panes[side].saved;
  }

  function onkey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "s") {
      e.preventDefault();
      const side = diff.focusedSide();
      if (e.shiftKey || !side) { save("a"); save("b"); } else save(side);
    } else if (mod && e.key === "o") {
      e.preventDefault();
      pick(e.shiftKey ? "b" : "a");
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      diff.jump(e.key === "ArrowDown" ? 1 : -1);
    }
  }

  onMount(() => {
    const unlisten: Array<Promise<() => void>> = [];

    // Drop on the left/right half of the window; two files at once fill both sides.
    unlisten.push(
      getCurrentWebview().onDragDropEvent((ev) => {
        const p = ev.payload;
        const sideAt = (x: number): Side =>
          x / window.devicePixelRatio < window.innerWidth / 2 ? "a" : "b";
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
        const ok = await ask("There are unsaved changes. Quit anyway?", {
          title: "Unsaved changes",
          kind: "warning",
        });
        if (ok) await win.destroy();
      }),
    );

    initialPaths().then(([a, b]) => {
      if (a) load("a", a);
      if (b) load("b", b);
    });

    return () => unlisten.forEach((u) => u.then((f) => f()));
  });
</script>

<svelte:window onkeydown={onkey} />

<main>
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

  <DiffView bind:this={diff} {dark} {revert} {collapse} {onchange} onchunks={(n) => (chunks = n)} />

  <footer>
    <span>{chunks} {chunks === 1 ? "difference" : "differences"}</span>
    <button onclick={() => diff.jump(-1)} title="Previous (⌥↑)">↑</button>
    <button onclick={() => diff.jump(1)} title="Next (⌥↓)">↓</button>
    <span class="spacer"></span>
    <label><input type="checkbox" bind:checked={collapse} /> Collapse unchanged</label>
    <label>
      Copy direction
      <select bind:value={revert}>
        <option value="a-to-b">left → right</option>
        <option value="b-to-a">right → left</option>
      </select>
    </label>
  </footer>
</main>

<style>
  main { display: flex; flex-direction: column; height: 100vh; }
  header { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .pane { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--panel); min-width: 0; transition: background 0.1s; }
  .pane.drop { background: var(--accent-soft); outline: 2px dashed var(--accent); outline-offset: -3px; }
  .path { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
  .path b, .path small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path small, .path i { color: var(--muted); font-size: 11px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--panel); border-top: 1px solid var(--border); font-size: 12px; }
  .spacer { flex: 1; }
  label { display: flex; align-items: center; gap: 4px; }
</style>
