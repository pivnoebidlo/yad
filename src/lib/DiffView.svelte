<script lang="ts">
  import { onMount } from "svelte";
  import { Compartment } from "@codemirror/state";
  import type { EditorView } from "@codemirror/view";
  import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
  import { baseSetup, languageExt, themeExt } from "./editor";
  import { langFor, type Side } from "./files";

  interface Props {
    dark: boolean;
    revert: "a-to-b" | "b-to-a";
    collapse: boolean;
    onchange: (side: Side, text: string) => void;
    onchunks: (count: number) => void;
  }
  let { dark, revert, collapse, onchange, onchunks }: Props = $props();

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

  function changed(side: Side) {
    if (!mv) return;
    onchange(side, view(side).state.doc.toString());
    onchunks(mv.chunks.length);
  }

  onMount(() => {
    const ext = (side: Side) =>
      baseSetup({ ...comp[side], lang: "plain", dark, onChange: () => changed(side) });
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
