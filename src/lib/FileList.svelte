<script lang="ts">
  import { isDirty, type Entry, type FileStatus } from "./workspace";
  import { t } from "./i18n.svelte";
  import { matcher } from "./filter";

  interface Props {
    entries: Entry[];
    current: number;
    onselect: (i: number) => void;
    /** Format or align every file on one side. */
    onbulk?: (kind: "format" | "align", side: "a" | "b") => void;
  }
  let { entries, current, onselect, onbulk }: Props = $props();

  let hideEqual = $state(true);
  let query = $state("");
  let list: HTMLDivElement;
  let filterInput: HTMLInputElement;
  const match = $derived(matcher(query));

  export function focusFilter() {
    filterInput?.focus();
    filterInput?.select();
  }
  export const filterFocused = () => document.activeElement === filterInput;

  const hint = (s: FileStatus) =>
    ({ changed: t("filesDiffer"), reordered: t("orderOnly"), equal: t("identical"), added: t("onlyRight"), removed: t("onlyLeft"), error: t("noParse") })[s];
  const counts = $derived.by(() => {
    const c: Record<FileStatus, number> = { changed: 0, reordered: 0, equal: 0, added: 0, removed: 0, error: 0 };
    for (const e of entries) c[e.status]++;
    return c;
  });
  const visible = $derived(
    entries
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => (match ? match(e.rel) : true) && (!hideEqual || (!match && i === current) || (e.status !== "equal" && e.status !== "reordered"))),
  );

  /** Select the next/previous visible file (arrow keys, Alt+Cmd+arrows). */
  export function move(delta: number) {
    if (!visible.length) return;
    const pos = visible.findIndex((v) => v.i === current);
    const next = pos < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, pos + delta));
    onselect(visible[next].i);
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-i="${visible[next].i}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function onkey(e: KeyboardEvent) {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, End: Infinity, Home: -Infinity }[e.key];
    if (step === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    move(step === Infinity ? visible.length : step === -Infinity ? -visible.length : step);
  }
</script>

<div class="files">
  <div class="summary">
    <span title={t("filesDiffer")}><i class="dot s-changed"></i>{counts.changed}</span>
    <span title={t("onlyRight")}><i class="dot s-added"></i>{counts.added}</span>
    <span title={t("onlyLeft")}><i class="dot s-removed"></i>{counts.removed}</span>
    <span title={t("orderOnly")}><i class="dot s-reordered"></i>{counts.reordered}</span>
    {#if counts.error}<span title={t("noParse")}><i class="dot s-error"></i>{counts.error}</span>{/if}
    <label title={t("hideEqualFilesTitle")}><input type="checkbox" bind:checked={hideEqual} /> {t("hideEqual")}</label>
  </div>
  <div class="filter">
    <input type="search" bind:this={filterInput} bind:value={query} placeholder={t("filterFiles")} spellcheck="false"
      onkeydown={(e) => { if (e.key === "Escape") { query = ""; list?.focus(); } else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); list?.focus(); if (visible.length && !visible.some((v) => v.i === current)) onselect(visible[0].i); } }} />
    {#if match}<span class="found">{visible.length}</span>{/if}
  </div>
  {#if onbulk}
    <div class="bulk">
      <span>{t("bulkFormat")}</span>
      <button onclick={() => onbulk("format", "a")} title={t("bulkFormatTitle", { side: t("sideLeftName") })}>{t("bulkLeft")}</button>
      <button onclick={() => onbulk("format", "b")} title={t("bulkFormatTitle", { side: t("sideRightName") })}>{t("bulkRight")}</button>
      <span class="sep">{t("bulkAlign")}</span>
      <button onclick={() => onbulk("align", "a")} title={t("bulkAlignTitleLeft")}>{t("bulkLeft")}</button>
      <button onclick={() => onbulk("align", "b")} title={t("bulkAlignTitleRight")}>{t("bulkRight")}</button>
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="items" bind:this={list} tabindex="0" role="listbox" aria-label={t("files")} onkeydown={onkey}>
    {#each visible as { e, i } (e.rel)}
      <button class="row s-{e.status}" class:active={i === current} data-i={i} role="option" aria-selected={i === current}
        onclick={() => onselect(i)} title={`${e.rel}\n${hint(e.status)}`}>
        <i class="dot s-{e.status}"></i>
        <span class="name">{e.rel}</span>
        {#if isDirty(e.a) || isDirty(e.b)}<span class="dirty" title={t("unsaved")}>✎</span>{/if}
      </button>
    {:else}
      <div class="empty">{match ? t("nothingFound") : t("noDifferingFiles")}</div>
    {/each}
  </div>
</div>

<style>
  .files { display: flex; flex-direction: column; min-height: 0; flex: 1; font-size: 12px; }
  .summary { display: flex; gap: 10px; align-items: center; padding: 4px 10px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .summary span { display: flex; align-items: center; gap: 4px; }
  .summary label { margin-left: auto; display: flex; gap: 4px; align-items: center; color: var(--muted); }
  .filter { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-bottom: 1px solid var(--border); }
  .filter input { flex: 1; min-width: 0; font-size: 12px; padding: 2px 6px; }
  .found { color: var(--muted); font-variant-numeric: tabular-nums; }
  .bulk { display: flex; gap: 4px; align-items: center; padding: 3px 10px; border-bottom: 1px solid var(--border); color: var(--muted); white-space: nowrap; overflow: hidden; }
  .bulk .sep { margin-left: 8px; }
  .bulk button { padding: 0 6px; font-size: 11px; }
  .items { overflow-y: auto; min-height: 0; flex: 1; outline: none; }
  .items:focus-visible .row.active, .items:focus-within .row.active { box-shadow: inset 2px 0 0 var(--accent); }
  .empty { padding: 10px; color: var(--muted); text-align: center; }
  .row { all: unset; box-sizing: border-box; cursor: default; display: flex; gap: 7px; align-items: center; width: 100%; padding: 3px 10px; }
  .row:hover { background: var(--hover); }
  .row.active { background: var(--accent-soft); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dirty { color: var(--accent); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; box-sizing: border-box; }
  .dot.s-changed { background: var(--changed); }
  .dot.s-added { background: var(--added); }
  .dot.s-removed { background: var(--removed); }
  .dot.s-error { background: var(--removed); outline: 2px solid var(--removed); outline-offset: 1px; }
  .dot.s-reordered { border: 1.5px solid var(--muted); }
  .dot.s-equal { visibility: hidden; }
  .s-equal .name, .s-reordered .name { color: var(--muted); }
</style>
