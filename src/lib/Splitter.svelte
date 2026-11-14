<script lang="ts">
  interface Props {
    /** "row": drag vertically between stacked panes; "col": drag horizontally. */
    dir?: "row" | "col";
    ondrag: (delta: number) => void;
  }
  let { dir = "row", ondrag }: Props = $props();

  let last = 0;
  function down(e: PointerEvent) {
    e.preventDefault();
    last = dir === "row" ? e.clientY : e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const pos = dir === "row" ? e.clientY : e.clientX;
    if (pos !== last) ondrag(pos - last);
    last = pos;
  }
</script>

<div class="split {dir}" role="separator" aria-orientation={dir === "row" ? "horizontal" : "vertical"}
  onpointerdown={down} onpointermove={move}></div>

<style>
  .split { flex: none; position: relative; z-index: 2; }
  .split.row { height: 5px; margin: -3px 0 -2px; cursor: row-resize; }
  .split.col { width: 5px; margin: 0 -3px 0 -2px; cursor: col-resize; }
  .split:hover, .split:active { background: var(--accent-soft); }
</style>
