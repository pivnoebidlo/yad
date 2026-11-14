<script lang="ts">
  import { formatPath, type Change, type CompareResult, type ResourceDiff, type ResourceStatus } from "./semantic";

  interface Props {
    result: CompareResult | null;
    onresource: (r: ResourceDiff) => void;
    onchange: (r: ResourceDiff, c: Change) => void;
    onedit: (r: ResourceDiff, c: Change) => void;
  }
  let { result, onresource, onchange, onedit }: Props = $props();

  let hideEqual = $state(true);
  let collapsed = $state<Record<string, boolean>>({});
  let active = $state<string | null>(null);

  const icon: Record<ResourceStatus, string> = { changed: "~", added: "+", removed: "−", equal: "=" };

  const counts = $derived.by(() => {
    const c = { changed: 0, added: 0, removed: 0, equal: 0 };
    for (const r of result?.resources ?? []) c[r.status]++;
    return c;
  });
  const shown = $derived((result?.resources ?? []).filter((r) => !hideEqual || r.status !== "equal"));
  const errors = $derived(
    result ? [...result.errors.a.map((e) => ({ side: "Left", ...e })), ...result.errors.b.map((e) => ({ side: "Right", ...e }))] : [],
  );

  function short(v: unknown): string {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }

  function changeText(c: Change): string {
    if (c.kind === "changed") return `${short(c.a)} → ${short(c.b)}`;
    return short(c.kind === "added" ? c.b : c.a);
  }

  const changeId = (r: ResourceDiff, i: number) => `${r.key}#${formatPath(r.changes[i].path)}`;
</script>

<div class="list">
  <div class="summary">
    <span class="s-changed" title="Changed">~{counts.changed}</span>
    <span class="s-added" title="Only on the right">+{counts.added}</span>
    <span class="s-removed" title="Only on the left">−{counts.removed}</span>
    <span class="s-equal" title="Equal">={counts.equal}</span>
    <label title="Hide equal resources"><input type="checkbox" bind:checked={hideEqual} /> hide equal</label>
  </div>

  {#each errors as e}
    <div class="error">{e.side}, line {e.line}: {e.message}</div>
  {/each}

  <div class="items">
    {#each shown as r (r.key)}
      <button
        class="res s-{r.status}"
        class:active={active === r.key}
        onclick={() => {
          active = r.key;
          if (r.changes.length) collapsed[r.key] = !collapsed[r.key];
          onresource(r);
        }}
      >
        <span class="icon">{icon[r.status]}</span>
        <span class="label" title={r.label}>{r.label}</span>
        {#if r.changes.length}<span class="count">{r.changes.length}</span>{/if}
      </button>
      {#if r.changes.length && !collapsed[r.key]}
        {#each r.changes as c, i}
          <div class="change s-{c.kind}" class:active={active === changeId(r, i)}>
            <button
              class="change-main"
              title={`${formatPath(c.path)}\n${changeText(c)}`}
              onclick={() => { active = changeId(r, i); onchange(r, c); }}
            >
              <span class="path">{formatPath(c.path)}</span>
              <span class="value">{changeText(c)}</span>
            </button>
            <button class="edit" title="Edit in source (Text mode)" onclick={() => { active = changeId(r, i); onedit(r, c); }}>✎</button>
          </div>
        {/each}
      {/if}
    {:else}
      <div class="empty">{result ? (result.resources.length ? "No differences" : "Nothing to compare") : "Open two files"}</div>
    {/each}
  </div>
</div>

<style>
  .list { display: flex; flex-direction: column; min-height: 0; flex: 1; font-size: 12px; }
  .summary { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .summary label { margin-left: auto; display: flex; gap: 4px; align-items: center; color: var(--muted); }
  .items { overflow-y: auto; flex: 1; padding-bottom: 8px; }
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
  .edit { padding: 2px 8px; opacity: 0; color: var(--muted); }
  .change:hover .edit, .change.active .edit { opacity: 1; }
  .edit:hover { color: var(--accent); }
  .res:hover, .change:hover { background: var(--hover); }
  .active { background: var(--accent-soft) !important; }
  .s-changed .icon, .s-changed.change .path, .summary .s-changed { color: var(--changed); }
  .s-added .icon, .s-added.change .path, .summary .s-added { color: var(--added); }
  .s-removed .icon, .s-removed.change .path, .summary .s-removed { color: var(--removed); }
  .s-equal .icon, .summary .s-equal, .res.s-equal { color: var(--muted); }
</style>
