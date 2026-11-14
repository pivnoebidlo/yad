<script lang="ts">
  import type { Op } from "./workspace";

  interface Props {
    ops: Op[];
    showFiles: boolean;
    onrevert: (op: Op) => void;
  }
  let { ops, showFiles, onrevert }: Props = $props();
</script>

{#if ops.length}
  <div class="history">
    <div class="title">History <span class="muted">· {ops.length}</span></div>
    <div class="items">
      {#each [...ops].reverse() as op (op.id)}
        <div class="row">
          <div class="text" title={op.label}>
            <span class="label">{op.label}</span>
            <small>{op.side === "a" ? "left" : "right"}{showFiles && op.rel ? ` · ${op.rel}` : ""}</small>
          </div>
          <button title="Undo this change only (later edits are kept)" onclick={() => onrevert(op)}>Undo</button>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .history { flex: none; max-height: 30%; display: flex; flex-direction: column; border-top: 1px solid var(--border); font-size: 12px; min-height: 0; }
  .title { padding: 6px 10px; font-weight: 600; }
  .muted { color: var(--muted); font-weight: 400; }
  .items { overflow-y: auto; min-height: 0; padding-bottom: 6px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 3px 10px; }
  .row:hover { background: var(--hover); }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .label, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  small { color: var(--muted); font-size: 11px; }
  button { font-size: 11px; padding: 1px 8px; }
</style>
