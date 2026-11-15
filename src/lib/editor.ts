// Minimal CodeMirror setup: only what a diff editor needs, to keep the bundle small.
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, type ViewUpdate, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter,
  foldKeymap, indentOnInput, indentUnit,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Lang } from "./files";

export const languageExt = (lang: Lang): Extension =>
  lang === "yaml" ? yaml() : lang === "json" ? json() : [];

export type EditorTheme = "light" | "dark" | "oldschool";

/** Norton Commander colors: blue panels, cyan text, yellow keys. */
const nc = { bg: "#0000aa", text: "#55ffff", cyan: "#00aaaa", yellow: "#ffff55", white: "#ffffff", green: "#55ff55", magenta: "#ff55ff", gray: "#aaaaaa" };
const oldschool: Extension = [
  EditorView.theme(
    {
      "&": { backgroundColor: nc.bg, color: nc.text },
      ".cm-content": { caretColor: nc.yellow },
      ".cm-cursor, .cm-dropCursor": { borderLeft: `0.6em solid ${nc.yellow}`, opacity: 0.7 },
      ".cm-gutters": { backgroundColor: nc.bg, color: nc.cyan, borderRight: `3px double ${nc.text}` },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#0000cc" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: `${nc.cyan} !important` },
      ".cm-selectionMatch": { backgroundColor: "#000088" },
      ".cm-searchMatch": { backgroundColor: nc.cyan, color: "#000" },
      ".cm-panels": { backgroundColor: nc.cyan, color: "#000" },
      ".cm-foldPlaceholder": { backgroundColor: nc.cyan, color: "#000", border: "none" },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: nc.yellow },
      { tag: [tags.string, tags.special(tags.string), tags.content], color: nc.white },
      { tag: [tags.number, tags.integer, tags.float], color: nc.green },
      { tag: [tags.bool, tags.null, tags.atom], color: nc.magenta },
      { tag: [tags.comment, tags.lineComment, tags.blockComment], color: nc.gray, fontStyle: "italic" },
      { tag: [tags.punctuation, tags.separator, tags.bracket, tags.meta], color: nc.text },
    ]),
  ),
];

/**
 * Diff highlighting in two levels, readable at a glance: changed lines get a
 * clear tint, the changed words inside them a solid one (the merge view's
 * defaults are an 8% tint and a thin underline). Left is red, right is green.
 */
type DiffColors = { lineA: string; lineB: string; textA: string; textB: string; gutterA: string; gutterB: string; text?: string; selection: string };
const DIFF: Record<EditorTheme, DiffColors> = {
  light: {
    lineA: "rgba(207, 34, 46, 0.10)", lineB: "rgba(26, 127, 55, 0.11)",
    textA: "rgba(207, 34, 46, 0.28)", textB: "rgba(26, 127, 55, 0.30)",
    gutterA: "#cf222e", gutterB: "#1a7f37", selection: "rgba(10, 132, 255, 0.28)",
  },
  dark: {
    lineA: "rgba(248, 81, 73, 0.15)", lineB: "rgba(63, 185, 80, 0.15)",
    textA: "rgba(248, 81, 73, 0.42)", textB: "rgba(63, 185, 80, 0.40)",
    gutterA: "#f85149", gutterB: "#3fb950", selection: "rgba(10, 132, 255, 0.40)",
  },
  oldschool: {
    lineA: "rgba(255, 85, 85, 0.22)", lineB: "rgba(85, 255, 85, 0.16)",
    textA: "#aa0000", textB: "#00aa00", text: "#ffffff",
    gutterA: "#ff5555", gutterB: "#55ff55", selection: "#00aaaa",
  },
};

function diffTheme(theme: EditorTheme): Extension {
  const c = DIFF[theme];
  const word = (bg: string) => ({ background: bg, borderRadius: "2px", ...(c.text ? { color: c.text } : {}) });
  return EditorView.theme({
    "&.cm-merge-a .cm-changedLine, & .cm-deletedChunk": { backgroundColor: c.lineA },
    "&.cm-merge-b .cm-changedLine, & .cm-inlineChangedLine": { backgroundColor: c.lineB },
    "&.cm-merge-a .cm-changedText, & .cm-deletedChunk .cm-deletedText": word(c.textA),
    "&.cm-merge-b .cm-changedText": word(c.textB),
    "& .cm-changeGutter": { width: "4px", paddingLeft: "0" },
    "&.cm-merge-a .cm-changedLineGutter, & .cm-deletedLineGutter": { background: c.gutterA },
    "&.cm-merge-b .cm-changedLineGutter": { background: c.gutterB },
    // Selection: clearly visible over the tints, in and out of focus.
    "&.cm-focused .cm-selectionBackground, & .cm-selectionBackground, & .cm-content ::selection": { backgroundColor: `${c.selection} !important` },
  });
}

export const themeExt = (theme: EditorTheme): Extension => [
  theme === "dark" ? oneDark : theme === "oldschool" ? oldschool : [],
  diffTheme(theme),
];

export function baseSetup(opts: {
  language: Compartment;
  theme: Compartment;
  history: Compartment;
  lang: Lang;
  theme0: EditorTheme;
  readonly?: boolean;
  onChange?: () => void;
  onUpdate?: (u: ViewUpdate) => void;
}): Extension {
  return [
    opts.readonly ? EditorState.readOnly.of(true) : [],
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    opts.history.of(history()),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    opts.language.of(languageExt(opts.lang)),
    opts.theme.of(themeExt(opts.theme0)),
    EditorView.updateListener.of((u) => {
      opts.onUpdate?.(u);
      if (u.docChanged) opts.onChange?.();
    }),
  ];
}
