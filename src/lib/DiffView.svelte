<script lang="ts">
  import { onMount } from "svelte";
  import { Compartment, EditorState, Transaction, type ChangeDesc } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { MergeView, goToNextChunk, goToPreviousChunk, type Chunk } from "@codemirror/merge";
  import { history, undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
  import { minimalEdit } from "./workspace";
  import { baseSetup, languageExt, themeExt, type EditorTheme } from "./editor";
  import { langFor, type Side } from "./files";
  import type { Direction, Edit } from "./semantic";
  import type { Marker } from "./workspace";
  import { t } from "./i18n.svelte";

  type Span = { from: number; to: number };

  interface Props {
    theme: EditorTheme;
    collapse: boolean;
    readonly?: boolean;
    /** Show →/← buttons between the editors for every chunk. */
    arrows?: boolean;
    /** Custom handler for an arrow; without it the chunk text is copied. `part`: see `subArrows`. */
    onarrow?: (chunk: Chunk, dir: Direction, part: number) => void;
    /**
     * Extra arrows inside a chunk (parts 1…n; the chunk's own arrow is part 0),
     * at a line relative to the chunk start on one side.
     */
    subArrows?: (chunk: Chunk) => { side: Side; line: number }[];
    onchange?: (side: Side, text: string) => void;
    /** The user (not the program) changed a document: typing, paste, undo… */
    onuseredit?: (side: Side) => void;
    /** Every document change, for mapping stored positions. */
    ontx?: (side: Side, changes: ChangeDesc) => void;
    onchunks?: (count: number) => void;
    markers?: Marker[];
    onmarker?: (id: number) => void;
  }
  let {
    theme, collapse, readonly = false, arrows = true, onarrow, subArrows, onchange, onuseredit, ontx, onchunks,
    markers = [], onmarker,
  }: Props = $props();

  let host: HTMLDivElement;
  let mv: MergeView | undefined;
  const comp = {
    a: { language: new Compartment(), theme: new Compartment(), history: new Compartment(), ro: new Compartment() },
    b: { language: new Compartment(), theme: new Compartment(), history: new Compartment(), ro: new Compartment() },
  };

  const collapseConf = (on: boolean) => (on ? { margin: 3, minSize: 6 } : undefined);

  function view(side: Side): EditorView {
    return side === "a" ? mv!.a : mv!.b;
  }

  // Word-level highlighting is noise when most of the text differs
  // (e.g. a reordered file): then only line backgrounds are shown. Hidden
  // with a class: switching `highlightChanges` at runtime breaks rendering
  // in @codemirror/view >= 6.39 (blank editor, "Cannot destructure property 'tile'").
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
      host.classList.toggle("no-inline", !want);
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
    el.dataset.part = "0";
    for (const [dir, label, title] of [
      ["a-to-b", "→", t("replaceRight")],
      ["b-to-a", "←", t("replaceLeft")],
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
    const part = Number(btn.closest<HTMLElement>("[data-part]")?.dataset.part ?? 0);
    if (onarrow) onarrow(chunk, dir, part);
    else copyChunk(chunk, dir);
  }

  // ---- undo markers (✕) in the arrow column ---------------------------------
  // The column itself is rebuilt by MergeView, so markers live in an overlay
  // on top of it, positioned with the same line coordinates.
  let overlay: HTMLDivElement | undefined;
  let renderQueued = false;

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderMarkers();
    });
  }

  function renderMarkers() {
    const col = mv?.dom.querySelector<HTMLElement>(".cm-merge-revert");
    if (!mv || !overlay || !col) return;
    overlay.style.left = col.offsetLeft + "px";
    overlay.style.width = col.offsetWidth + "px";
    const used = new Set<number>();
    const nodes: HTMLElement[] = [];
    // Newest first, one marker per line.
    for (const m of [...markers].reverse()) {
      const v = view(m.side);
      const top = Math.round(v.lineBlockAt(Math.min(m.pos, v.state.doc.length)).top);
      if (used.has(top)) continue;
      used.add(top);
      const b = document.createElement("button");
      b.className = "yad-undo";
      b.textContent = "✕";
      b.title = t("undoThis", { what: m.title });
      b.style.top = top + "px";
      // Keep editor focus on press; act only on a full click on the button,
      // so a press that started elsewhere can never undo anything.
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onmarker?.(m.id);
      });
      nodes.push(b);
    }
    // A ✕ takes the place of the arrows on its line.
    const covered = (top: number) => [...used].some((u) => Math.abs(u - top) < 4);
    for (const el of col.querySelectorAll<HTMLElement>(":scope > .yad-arrows"))
      el.classList.toggle("yad-covered", covered(parseFloat(el.style.top)));
    if (arrows && subArrows) nodes.push(...renderSubArrows().filter((el) => !covered(parseFloat(el.style.top))));
    overlay.replaceChildren(...nodes);
  }

  /** Arrows for the extra parts of the chunks in view. */
  function renderSubArrows(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const vpA = mv!.a.viewport, vpB = mv!.b.viewport;
    mv!.chunks.forEach((chunk, i) => {
      if ((chunk.toA < vpA.from || chunk.fromA > vpA.to) && (chunk.toB < vpB.from || chunk.fromB > vpB.to)) return;
      subArrows!(chunk).forEach(({ side, line }, k) => {
        const v = view(side);
        const doc = v.state.doc;
        const first = doc.lineAt(Math.min(side === "a" ? chunk.fromA : chunk.fromB, doc.length)).number;
        const pos = doc.line(Math.min(first + line, doc.lines)).from;
        const el = renderArrows();
        el.classList.add("yad-subarrows");
        el.dataset.chunk = String(i);
        el.dataset.part = String(k + 1);
        el.style.top = Math.round(v.lineBlockAt(pos).top) + "px";
        out.push(el);
      });
    });
    return out;
  }

  $effect(() => {
    markers; // re-render when the list changes
    queueRender();
  });

  onMount(() => {
    const ext = (side: Side) => [
      comp[side].ro.of([]),
      baseSetup({
        ...comp[side], lang: "plain", theme0: theme, readonly,
        onChange: () => changed(side),
        onUpdate: (u) => {
          if (u.docChanged) ontx?.(side, u.changes);
          if (u.docChanged && u.transactions.some((tr) => tr.annotation(Transaction.userEvent) !== undefined)) onuseredit?.(side);
          if (u.docChanged || u.geometryChanged || u.viewportChanged) queueRender();
        },
      }),
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
    overlay = document.createElement("div");
    overlay.className = "yad-markers";
    mv.dom.querySelector(".cm-mergeViewEditors")?.appendChild(overlay);
    // The merge view adds and moves its arrows on its own schedule: re-check
    // which of them a ✕ covers.
    const col = mv.dom.querySelector(".cm-merge-revert");
    const obs = new MutationObserver(queueRender);
    if (col) obs.observe(col, { childList: true, subtree: true, attributeFilter: ["style"] });
    return () => {
      obs.disconnect();
      mv?.destroy();
    };
  });

  $effect(() => {
    const th = theme;
    if (!mv) return;
    for (const side of ["a", "b"] as const)
      view(side).dispatch({ effects: comp[side].theme.reconfigure(themeExt(th)) });
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

  /**
   * Bring a side to `text` with the smallest edit, outside the undo history:
   * the cursor stays where it was (used to refresh the semantic view while
   * the user works in it). `resetHistory`: the text was replaced from outside
   * (reloaded from disk), so earlier edits can no longer be undone.
   */
  export function setDocSoft(side: Side, text: string, resetHistory = false) {
    const v = view(side);
    const cur = v.state.doc.toString();
    if (cur !== text) v.dispatch({ changes: minimalEdit(cur, text), annotations: Transaction.addToHistory.of(false) });
    if (resetHistory) {
      v.dispatch({ effects: comp[side].history.reconfigure([]) });
      v.dispatch({ effects: comp[side].history.reconfigure(history()) });
    }
  }

  /** Make one side read-only (generated text) or editable again. */
  export function setReadOnly(side: Side, on: boolean) {
    view(side).dispatch({ effects: comp[side].ro.reconfigure(on ? EditorState.readOnly.of(true) : []) });
  }

  export function cursor(side: Side): number {
    return view(side).state.selection.main.head;
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
  .diff:global(.no-inline) :global(.cm-changedText) {
    background: none !important;
    color: inherit !important;
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
  .diff :global(.cm-mergeViewEditors) {
    position: relative;
  }
  .diff :global(.yad-markers) {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
  }
  .diff :global(.yad-undo) {
    position: absolute;
    left: 15px; /* centered where the arrows are */
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
    font: 11px/18px -apple-system, system-ui, sans-serif;
    cursor: pointer;
    pointer-events: auto;
  }
  .diff :global(.yad-undo:hover) {
    background: var(--removed);
    color: white;
  }
  .diff :global(.cm-merge-revert) {
    width: 48px;
    background: var(--panel);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }
  .diff :global(.yad-arrows) {
    position: absolute;
    left: 3px;
    display: flex;
    gap: 2px;
  }
  .diff :global(.yad-subarrows) {
    pointer-events: auto;
  }
  .diff :global(.yad-covered) {
    visibility: hidden;
  }
  .diff :global(.yad-subarrows button) {
    text-align: center;
    background: none;
    border: none;
    cursor: pointer;
  }
  .diff :global(.cm-merge-revert .yad-arrows button),
  .diff :global(.yad-subarrows button) {
    position: static;
    width: 20px;
    height: 18px;
    padding: 0;
    line-height: 16px;
    border-radius: 4px;
    color: var(--muted);
    font-size: 13px;
  }
  .diff :global(.cm-merge-revert .yad-arrows button:hover),
  .diff :global(.yad-subarrows button:hover) {
    background: var(--accent);
    color: white;
  }
</style>
