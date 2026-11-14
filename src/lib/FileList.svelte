<script lang="ts">
  import { isDirty, type Entry, type FileStatus } from "./workspace";
  import type { Direction } from "./semantic";

  interface Props {
    entries: Entry[];
    current: number;
    onselect: (i: number) => void;
    oncopy: (i: number, dir: Direction) => void;
  }
  let { entries, current, onselect, oncopy }: Props = $props();

  let hideEqual = $state(true);
  const icon: Record<FileStatus, string> = { changed: "~", reordered: "≈", equal: "=", added: "+", removed: "−", error: "!" };
  const hint: Record<FileStatus, string> = {
    changed: "Differs",
    reordered: "Same content, different order/formatting",
    equal: "Identical",
    added: "Only on the right",
    removed: "Only on the left",
    error: "Does not parse",
  };
  const counts = $derived.by(() => {
    const c: Record<FileStatus, number> = { changed: 0, reordered: 0, equal: 0, added: 0, removed: 0, error: 0 };
    for (const e of entries) c[e.status]++;
    return c;
  });
  const visible = $derived(
    entries.map((e, i) => ({ e, i })).filter(({ e, i }) => !hideEqual || i === current || (e.status !== "equal" && e.status !== "reordered")),
  );
</script>

<div class="files">
  <div class="summary">
    <span class="s-changed" title="Differ">~{counts.changed}</span>
    <span class="s-added" title="Only on the right">+{counts.added}</span>
    <span class="s-removed" title="Only on the left">−{counts.removed}</span>
    <span class="s-equal" title="Equal or only reordered">={counts.equal + counts.reordered}</span>
    {#if counts.error}<span class="s-error" title="Do not parse">!{counts.error}</span>{/if}
    <label title="Hide equal and reordered files"><input type="checkbox" bind:checked={hideEqual} /> hide equal</label>
  </div>
  <div class="items">
    {#each visible as { e, i } (e.rel)}
      <div class="row s-{e.status}" class:active={i === current}>
        <button class="main" onclick={() => onselect(i)} title={`${e.rel}\n${hint[e.status]}`}>
          <span class="icon">{icon[e.status]}</span>
          <span class="name">{e.rel}</span>
          {#if isDirty(e.a) || isDirty(e.b)}<span class="dirty" title="Unsaved changes">•</span>{/if}
        </button>
        {#if e.status !== "equal"}
          <span class="arrows">
            {#if e.a}<button title="Copy file left → right" onclick={() => oncopy(i, "a-to-b")}>→</button>{/if}
            {#if e.b}<button title="Copy file right → left" onclick={() => oncopy(i, "b-to-a")}>←</button>{/if}
          </span>
        {/if}
      </div>
    {:else}
      <div class="empty">No differing files</div>
    {/each}
  </div>
</div>

<style>
  .files { display: flex; flex-direction: column; min-height: 0; max-height: 45%; flex: none; border-bottom: 1px solid var(--border); font-size: 12px; }
  .summary { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .summary label { margin-left: auto; display: flex; gap: 4px; align-items: center; color: var(--muted); }
  .items { overflow-y: auto; min-height: 0; }
  .empty { padding: 10px; color: var(--muted); text-align: center; }
  button { all: unset; box-sizing: border-box; cursor: default; }
  .row { display: flex; align-items: center; }
  .row:hover { background: var(--hover); }
  .row.active { background: var(--accent-soft); }
  .main { flex: 1; min-width: 0; display: flex; gap: 6px; align-items: center; padding: 3px 10px; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon { width: 12px; text-align: center; font-family: ui-monospace, Menlo, monospace; }
  .dirty { color: var(--accent); font-weight: 700; }
  .arrows { display: flex; gap: 2px; padding-right: 6px; opacity: 0; }
  .row:hover .arrows, .row.active .arrows { opacity: 1; }
  .arrows button { padding: 0 5px; border-radius: 4px; color: var(--muted); }
  .arrows button:hover { background: var(--accent); color: white; }
  .s-changed .icon, .summary .s-changed { color: var(--changed); }
  .s-added .icon, .summary .s-added { color: var(--added); }
  .s-removed .icon, .summary .s-removed { color: var(--removed); }
  .s-error .icon, .summary .s-error { color: var(--removed); }
  .s-equal .icon, .s-reordered .icon, .summary .s-equal, .s-equal .name, .s-reordered .name { color: var(--muted); }
</style>
