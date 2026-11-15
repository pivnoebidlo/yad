<script lang="ts">
  import { settings } from "./prefs.svelte";
  import { decodeSecretValue, isMultiline, isSecret, summarizeTextChange, formatPath, shortPath, type ApplyItem, type Change, type CompareResult, type Direction, type ResourceDiff, type ResourceStatus } from "./semantic";
  import { t } from "./i18n.svelte";
  import { matcher } from "./filter";

  interface Props {
    result: CompareResult | null;
    onresource: (r: ResourceDiff) => void;
    onchange: (r: ResourceDiff, c: Change) => void;
    onedit: (r: ResourceDiff, c: Change) => void;
    onapply: (items: ApplyItem[], dir: Direction) => void;
  }
  let { result, onresource, onchange, onedit, onapply }: Props = $props();

  let hideEqual = $state(true);
  let collapsed = $state<Record<string, boolean>>({});
  let active = $state<string | null>(null);

  const icon: Record<ResourceStatus, string> = { changed: "~", added: "+", removed: "−", equal: "=" };

  const counts = $derived.by(() => {
    const c = { changed: 0, added: 0, removed: 0, equal: 0 };
    for (const r of result?.resources ?? []) c[r.status]++;
    return c;
  });
  let query = $state("");
  let filterInput: HTMLInputElement;
  const match = $derived(matcher(query));
  export function focusFilter() {
    filterInput?.focus();
    filterInput?.select();
  }

  /**
   * Resources (and their changes) to list. With a filter, a resource whose
   * name matches keeps all its changes; otherwise only matching changes stay.
   */
  const shown = $derived.by(() => {
    const out: Array<{ r: ResourceDiff; changes: number[] }> = [];
    for (const r of result?.resources ?? []) {
      if (hideEqual && r.status === "equal") continue;
      const all = r.changes.map((_, i) => i);
      if (!match || match(r.label)) {
        out.push({ r, changes: all });
        continue;
      }
      const hits = all.filter((i) => match(`${r.label} ${formatPath(r.changes[i].path)} ${changeText(r, r.changes[i])}`));
      if (hits.length) out.push({ r, changes: hits });
    }
    return out;
  });
  const warnings = $derived(
    result ? [...result.warnings.a.map((e) => ({ side: t("sideLeftName"), ...e })), ...result.warnings.b.map((e) => ({ side: t("sideRightName"), ...e }))] : [],
  );
  const errors = $derived(
    result ? [...result.errors.a.map((e) => ({ side: "Left", ...e })), ...result.errors.b.map((e) => ({ side: "Right", ...e }))] : [],
  );

  function short(v: unknown): string {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }

  function changeText(r: ResourceDiff, c0: Change): string {
    const secret = settings.decodeSecrets && isSecret(r.a ?? r.b);
    const c = secret ? { ...c0, a: decodeSecretValue(c0.path, c0.a), b: decodeSecretValue(c0.path, c0.b) } : c0;
    if (c.kind === "moved") {
      const to = c.path[c.path.length - 1] as number;
      return `${t("movedText", { from: (c.fromIndex ?? 0) + 1, to: to + 1 })} · ${short(c.b)}`;
    }
    if (c.kind === "changed" && typeof c.a === "string" && typeof c.b === "string" && (isMultiline(c.a) || isMultiline(c.b)))
      return summarizeTextChange(c.a, c.b, (s) => (s.length > 40 ? s.slice(0, 37) + "…" : s));
    if (c.kind === "changed") return `${short(c.a)} → ${short(c.b)}`;
    return short(c.kind === "added" ? c.b : c.a);
  }

  const changeId = (r: ResourceDiff, i: number) => `${r.key}#${formatPath(r.changes[i].path)}`;
</script>

<div class="list">
  <div class="summary">
    <span class="s-changed" title={t("changed")}>~{counts.changed}</span>
    <span class="s-added" title={t("onlyRight")}>+{counts.added}</span>
    <span class="s-removed" title={t("onlyLeft")}>−{counts.removed}</span>
    <span class="s-equal" title={t("equal")}>={counts.equal}</span>
    <label title={t("hideEqualResourcesTitle")}><input type="checkbox" bind:checked={hideEqual} /> {t("hideEqual")}</label>
  </div>

  {#each errors as e}
    <div class="error">{e.side}, line {e.line}: {e.message}</div>
  {/each}
  {#each warnings as w}
    <div class="warning">⚠ {w.side}, line {w.line}: {w.message}</div>
  {/each}

  <div class="filter">
    <input type="search" bind:this={filterInput} bind:value={query} placeholder={t("filterChanges")} spellcheck="false"
      onkeydown={(e) => e.key === "Escape" && (query = "")} />
  </div>

  <div class="items">
    {#each shown as { r, changes } (r.key)}
      <div class="res-row" class:active={active === r.key}>
      <button
        class="res s-{r.status}"
        onclick={() => {
          active = r.key;
          if (r.changes.length) collapsed[r.key] = !collapsed[r.key];
          onresource(r);
        }}
      >
        <span class="icon">{icon[r.status]}</span>
        <span class="label" title={r.label}>{r.label}</span>
        {#if r.changes.length}<span class="count">{changes.length < r.changes.length ? `${changes.length}/` : ""}{r.changes.length}</span>{/if}
      </button>
      {#if r.status !== "equal"}
        <span class="arrows res-arrows">
          <button title={r.a ? t("resMatchLeft") : t("resRemoveRight")} onclick={() => onapply([{ resource: r }], "a-to-b")}>→</button>
          <button title={r.b ? t("resMatchRight") : t("resRemoveLeft")} onclick={() => onapply([{ resource: r }], "b-to-a")}>←</button>
        </span>
      {/if}
      </div>
      {#if r.changes.length && (!collapsed[r.key] || match)}
        {#each changes.map((i) => [r.changes[i], i] as const) as [c, i]}
          <div class="change s-{c.kind}" class:active={active === changeId(r, i)}>
            <button
              class="change-main"
              title={`${formatPath(c.path)}\n${changeText(r, c)}`}
              onclick={() => { active = changeId(r, i); onchange(r, c); }}
            >
              <span class="path">{shortPath(c.path)}</span>
              <span class="value">{changeText(r, c)}</span>
            </button>
            <span class="arrows">
              <button title={t("applyLR")} onclick={() => onapply([{ resource: r, change: c }], "a-to-b")}>→</button>
              <button title={t("applyRL")} onclick={() => onapply([{ resource: r, change: c }], "b-to-a")}>←</button>
              <button title={t("showInSource")} onclick={() => { active = changeId(r, i); onedit(r, c); }}>✎</button>
            </span>
          </div>
        {/each}
      {/if}
    {:else}
      <div class="empty">{match ? t("nothingFound") : result ? (result.resources.length ? t("noDifferences") : t("nothingToCompare")) : t("openTwo")}</div>
    {/each}
  </div>
</div>

<style>
  .list { display: flex; flex-direction: column; min-height: 0; flex: 1; font-size: 12px; }
  .summary { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .summary label { margin-left: auto; display: flex; gap: 4px; align-items: center; color: var(--muted); }
  .items { overflow-y: auto; flex: 1; padding-bottom: 8px; }
  .filter { display: flex; padding: 4px 10px; border-bottom: 1px solid var(--border); }
  .filter input { flex: 1; min-width: 0; font-size: 12px; padding: 2px 6px; }
  .warning { padding: 4px 10px; color: var(--changed); border-bottom: 1px solid var(--border); white-space: pre-wrap; }
  .error { padding: 4px 10px; color: var(--removed); border-bottom: 1px solid var(--border); white-space: pre-wrap; }
  .empty { padding: 16px 10px; color: var(--muted); text-align: center; }
  button { all: unset; box-sizing: border-box; cursor: default; }
  .res { display: flex; gap: 6px; align-items: center; width: 100%; padding: 4px 10px; font-weight: 600; }
  .res .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .res .count { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
  .icon { width: 12px; text-align: center; font-family: ui-monospace, Menlo, monospace; }
  .change { display: flex; align-items: center; padding-left: 28px; }
  .change-main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 3px 4px; }
  .change .path, .change .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  .change .value { color: var(--muted); }
  .res-row { display: flex; align-items: center; }
  .res-row .res { flex: 1; min-width: 0; }
  .arrows { display: flex; gap: 2px; padding-right: 6px; opacity: 0; }
  .change:hover .arrows, .change.active .arrows, .res-row:hover .arrows, .res-row.active .arrows { opacity: 1; }
  .arrows button { padding: 0 5px; border-radius: 4px; color: var(--muted); font-size: 12px; }
  .arrows button:hover { background: var(--accent); color: white; }
  .res-row:hover, .change:hover { background: var(--hover); }
  .active { background: var(--accent-soft) !important; }
  .s-changed .icon, .s-changed.change .path, .summary .s-changed { color: var(--changed); }
  .s-added .icon, .s-added.change .path, .summary .s-added { color: var(--added); }
  .s-removed .icon, .s-removed.change .path, .summary .s-removed { color: var(--removed); }
  .s-moved.change .path { color: var(--accent); }
  .s-equal .icon, .summary .s-equal, .res.s-equal { color: var(--muted); }
</style>
