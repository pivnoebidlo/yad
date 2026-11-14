<script lang="ts">
  import { onMount } from "svelte";
  import { Compartment } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { MergeView, goToNextChunk, goToPreviousChunk, type Chunk } from "@codemirror/merge";
  import { history, undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
  import { baseSetup, languageExt, themeExt } from "./editor";
  import { langFor, type Side } from "./files";
  import type { Direction, Edit } from "./semantic";

  type Span = { from: number; to: number };

  interface Props {
    dark: boolean;
    collapse: boolean;
    readonly?: boolean;
    /** Show →/← buttons between the editors for every chunk. */
    arrows?: boolean;
    /** Custom handler for an arrow; without it the chunk text is copied. */
    onarrow?: (chunk: Chunk, dir: Direction) => void;
    /** Read-only views: the user double-clicked or started typing at `pos`. */
    onjump?: (side: Side, pos: number) => void;
    onchange?: (side: Side, text: string) => void;
    onchunks?: (count: number) => void;
  }
  let { dark, collapse, readonly = false, arrows = true, onarrow, onjump, onchange, onchunks }: Props = $props();

  let host: HTMLDivElement;
  let mv: MergeView | undefined;
  const comp = {
    a: { language: new Compartment(), theme: new Compartment(), history: new Compartment() },
    b: { language: new Compartment(), theme: new Compartment(), history: new Compartment() },
  };

  const collapseConf = (on: boolean) => (on ? { margin: 3, minSize: 6 } : undefined);

  function view(side: Side): EditorView {
    return side === "a" ? mv!.a : mv!.b;
  }

  // Word-level highlighting is noise when most of the text differs
  // (e.g. a reordered file): then only line backgrounds are shown.
  let inline = true;
  function updateInline() {
    if (!mv) return;
    const a = mv.a.state.doc, b = mv.b.state.doc;
    const span = (doc: typeof a, from: number, to: number) =>
      to > from ? doc.lineAt(Math.min(to, doc.length)).number - doc.lineAt(from).number + 1 : 0;
    let changedLines = 0;
    for (const c of mv.chunks) changedLines += Math.max(span(a, c.fromA, c.endA), span(b, c.fromB, c.endB));
    const want = changedLines <= Math.max(a.lines, b.lines) / 2;
    if (want !== inline) {
      inline = want;
      mv.reconfigure({ highlightChanges: want });
    }
  }

  function changed(side: Side) {
    if (!mv) return;
    onchange?.(side, view(side).state.doc.toString());
    onchunks?.(mv.chunks.length);
    updateInline();
  }

  function renderArrows(): HTMLElement {
    const el = document.createElement("div");
    el.className = "yad-arrows";
    for (const [dir, label, title] of [
      ["a-to-b", "→", "Replace right with left"],
      ["b-to-a", "←", "Replace left with right"],
    ]) {
      const b = document.createElement("button");
      b.dataset.dir = dir;
      b.textContent = label;
      b.title = title;
      el.appendChild(b);
    }
    return el;
  }

  /** Default arrow: copy the chunk's text over the other side (like Meld). */
  export function copyChunk(c: Chunk, dir: Direction) {
    if (!mv) return;
    const [src, dst, sf, st, df, dt] = dir === "b-to-a"
      ? [mv.b, mv.a, c.fromB, c.toB, c.fromA, c.toA]
      : [mv.a, mv.b, c.fromA, c.toA, c.fromB, c.toB];
    let insert = src.state.sliceDoc(sf, Math.max(sf, st - 1));
    if (sf != st && dt <= dst.state.doc.length) insert += src.state.lineBreak;
    dst.dispatch({ changes: { from: df, to: Math.min(dst.state.doc.length, dt), insert }, userEvent: "input.copy" });
    dst.focus(); // so that Cmd+Z undoes the copy
  }

  function onArrowDown(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-dir]");
    const holder = btn?.closest<HTMLElement>("[data-chunk]");
    if (!btn || !holder || !mv) return;
    e.preventDefault();
    e.stopPropagation();
    const chunk = mv.chunks[Number(holder.dataset.chunk)];
    if (!chunk) return;
    const dir = btn.dataset.dir as Direction;
    if (onarrow) onarrow(chunk, dir);
    else copyChunk(chunk, dir);
  }

  /** Read-only: double-click or a typing attempt asks to jump to the source. */
  const jumpHandlers = (side: Side) =>
    EditorView.domEventHandlers({
      dblclick(e, v) {
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null && onjump) { onjump(side, pos); return true; }
        return false;
      },
      keydown(e, v) {
        const typing = !e.metaKey && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace");
        if (typing && onjump) { e.preventDefault(); onjump(side, v.state.selection.main.head); return true; }
        return false;
      },
    });

  onMount(() => {
    const ext = (side: Side) => [
      baseSetup({ ...comp[side], lang: "plain", dark, readonly, onChange: () => changed(side) }),
      readonly ? jumpHandlers(side) : [],
    ];
    mv = new MergeView({
      a: { doc: "", extensions: ext("a") },
      b: { doc: "", extensions: ext("b") },
      parent: host,
      revertControls: arrows ? "a-to-b" : undefined,
      renderRevertControl: renderArrows,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: collapseConf(collapse),
    });
    mv.dom.addEventListener("mousedown", onArrowDown, true);
    return () => mv?.destroy();
  });

  $effect(() => {
    const d = dark;
    if (!mv) return;
    for (const side of ["a", "b"] as const)
      view(side).dispatch({ effects: comp[side].theme.reconfigure(themeExt(d)) });
  });

  $effect(() => {
    const conf = { collapseUnchanged: collapseConf(collapse) };
    mv?.reconfigure(conf);
  });

  /**
   * Replace a side's document. `fresh`: a different file is shown now, so the
   * undo history starts over (otherwise Cmd+Z would bring back the old file).
   */
  export function setDoc(side: Side, text: string, path: string | null, fresh = false) {
    const v = view(side);
    const effects = [comp[side].language.reconfigure(languageExt(langFor(path)))];
    if (fresh) effects.push(comp[side].history.reconfigure([]));
    if (v.state.doc.toString() === text) v.dispatch({ effects });
    else v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, effects });
    if (fresh) v.dispatch({ effects: comp[side].history.reconfigure(history()) });
  }

  export function undo(side: Side) {
    cmUndo(view(side));
  }

  export function redo(side: Side) {
    cmRedo(view(side));
  }

  export function getDoc(side: Side): string {
    return view(side).state.doc.toString();
  }

  /** Apply edits as one undoable step. */
  export function applyEdits(side: Side, edits: Edit[]) {
    if (!edits.length) return;
    view(side).dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })), userEvent: "input.copy" });
  }

  /** The side whose editor currently has keyboard focus. */
  export function focusedSide(): Side | null {
    if (mv?.a.hasFocus) return "a";
    if (mv?.b.hasFocus) return "b";
    return null;
  }

  export function jump(dir: 1 | -1) {
    const v = view(focusedSide() ?? "b");
    (dir > 0 ? goToNextChunk : goToPreviousChunk)(v);
    v.focus();
  }

  /** Select and scroll to ranges on either side; focuses `focus` (or the right side). */
  export function select(spans: Partial<Record<Side, Span>>, focus?: Side) {
    if (!mv) return;
    for (const side of ["a", "b"] as const) {
      const s = spans[side];
      if (!s) continue;
      const v = view(side);
      const len = v.state.doc.length;
      const from = Math.min(s.from, len), to = Math.min(s.to, len);
      v.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
    }
    const target = focus && spans[focus] ? focus : spans.b ? "b" : "a";
    if (spans[target]) view(target).focus();
  }
</script>

<div class="diff" bind:this={host}></div>

<style>
  .diff {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .diff :global(.cm-mergeView) {
    height: 100%;
  }
  .diff :global(.cm-editor) {
    font-size: 13px;
  }
  .diff :global(.cm-scroller) {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .diff :global(.cm-merge-revert) {
    width: 46px;
    background: var(--panel);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }
  .diff :global(.yad-arrows) {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    gap: 2px;
  }
  .diff :global(.cm-merge-revert .yad-arrows button) {
    position: static;
    width: 20px;
    height: 18px;
    padding: 0;
    line-height: 16px;
    border-radius: 4px;
    color: var(--muted);
    font-size: 13px;
  }
  .diff :global(.cm-merge-revert .yad-arrows button:hover) {
    background: var(--accent);
    color: white;
  }
</style>
