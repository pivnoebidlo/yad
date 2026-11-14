<script lang="ts">
  import { onMount } from "svelte";
  import { Compartment } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
  import { baseSetup, languageExt, themeExt } from "./editor";
  import { langFor, type Side } from "./files";

  type Span = { from: number; to: number };

  interface Props {
    dark: boolean;
    /** Arrow direction for copy-chunk buttons; omit to hide them. */
    revert?: "a-to-b" | "b-to-a";
    collapse: boolean;
    readonly?: boolean;
    onchange?: (side: Side, text: string) => void;
    onchunks?: (count: number) => void;
  }
  let { dark, revert, collapse, readonly = false, onchange, onchunks }: Props = $props();

  let host: HTMLDivElement;
  let mv: MergeView | undefined;
  const comp = {
    a: { language: new Compartment(), theme: new Compartment() },
    b: { language: new Compartment(), theme: new Compartment() },
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
    const lines = (side: Side) => view(side).state.doc.lines;
    let changedLines = 0;
    for (const c of mv.chunks) {
      const a = mv.a.state.doc, b = mv.b.state.doc;
      changedLines += Math.max(
        c.endA > c.fromA ? a.lineAt(Math.min(c.endA, a.length)).number - a.lineAt(c.fromA).number + 1 : 0,
        c.endB > c.fromB ? b.lineAt(Math.min(c.endB, b.length)).number - b.lineAt(c.fromB).number + 1 : 0,
      );
    }
    const want = changedLines <= Math.max(lines("a"), lines("b")) / 2;
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

  onMount(() => {
    const ext = (side: Side) =>
      baseSetup({ ...comp[side], lang: "plain", dark, readonly, onChange: () => changed(side) });
    mv = new MergeView({
      a: { doc: "", extensions: ext("a") },
      b: { doc: "", extensions: ext("b") },
      parent: host,
      revertControls: revert,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: collapseConf(collapse),
    });
    return () => mv?.destroy();
  });

  $effect(() => {
    const d = dark;
    if (!mv) return;
    for (const side of ["a", "b"] as const)
      view(side).dispatch({ effects: comp[side].theme.reconfigure(themeExt(d)) });
  });

  $effect(() => {
    const conf = { revertControls: revert, collapseUnchanged: collapseConf(collapse) };
    mv?.reconfigure(conf);
  });

  /** Replace a side's document (e.g. after opening a file). */
  export function setDoc(side: Side, text: string, path: string | null) {
    const v = view(side);
    if (v.state.doc.toString() === text) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      effects: comp[side].language.reconfigure(languageExt(langFor(path))),
    });
  }

  export function getDoc(side: Side): string {
    return view(side).state.doc.toString();
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
</style>
