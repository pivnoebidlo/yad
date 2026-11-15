<script lang="ts">
  import { shortPath, type MergeConflict } from "./semantic";
  import { t, tn } from "./i18n.svelte";

  export type Pick = "ours" | "theirs";

  interface Props {
    conflicts: MergeConflict[];
    choice: Array<Pick | undefined>;
    applied: number;
    onpick: (i: number, side: Pick) => void;
    onselect: (c: MergeConflict) => void;
  }
  let { conflicts, choice, applied, onpick, onselect }: Props = $props();

  const open = $derived(conflicts.filter((_, i) => !choice[i]).length);

  function short(v: unknown): string {
    if (v === undefined) return t("notThere");
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }
</script>

<div class="list">
  <div class="summary">
    <span>{tn("mergeAuto", applied)}</span>
    {#if conflicts.length}
      <b class:done={!open}>{open ? tn("mergeConflictsLeft", open) : t("mergeAllResolved")}</b>
    {:else}
      <b class="done">{t("mergeNoConflicts")}</b>
    {/if}
  </div>
  <div class="items">
    {#each conflicts as c, i}
      <div class="conflict" class:resolved={!!choice[i]}>
        <button class="where" onclick={() => onselect(c)} title={t("mergeConflictHint")}>
          <span class="icon">{choice[i] ? "✓" : "!"}</span>
          <span class="label">{c.label}</span>
          <span class="path">{c.path ? shortPath(c.path) : t("wholeResource")}</span>
        </button>
        <div class="values">
          <span class="k">{t("mergeBase")}</span><span class="v">{short(c.base)}</span>
          <span class="k">{t("mergeOurs")}</span><span class="v">{short(c.ours)}</span>
          <span class="k">{t("mergeTheirs")}</span><span class="v">{short(c.theirs)}</span>
        </div>
        <div class="pick">
          <button class:on={choice[i] === "ours"} onclick={() => onpick(i, "ours")} title={t("mergeOursTitle")}>{t("pickOurs")}</button>
          <button class:on={choice[i] === "theirs"} onclick={() => onpick(i, "theirs")} title={t("mergeTheirsTitle")}>{t("pickTheirs")}</button>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .list { display: flex; flex-direction: column; min-height: 0; flex: 1; font-size: 12px; }
  .summary { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--muted); }
  .summary b { color: var(--changed); font-weight: 600; }
  .summary b.done { color: var(--added); }
  .items { overflow-y: auto; flex: 1; padding-bottom: 8px; }
  .conflict { padding: 6px 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
  .conflict.resolved { opacity: 0.7; }
  button { all: unset; box-sizing: border-box; cursor: default; }
  .where { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
  .where:hover .label { text-decoration: underline; }
  .icon { width: 12px; text-align: center; font-weight: 700; color: var(--changed); }
  .resolved .icon { color: var(--added); }
  .label { font-weight: 600; white-space: nowrap; }
  .path, .v { font-family: ui-monospace, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .values { display: grid; grid-template-columns: auto 1fr; gap: 1px 8px; padding-left: 18px; }
  .k { color: var(--muted); }
  .pick { display: flex; gap: 4px; padding-left: 18px; }
  .pick button { padding: 1px 10px; border: 1px solid var(--border); border-radius: 4px; }
  .pick button:hover { background: var(--hover); }
  .pick button.on { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
</style>
