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

export const themeExt = (theme: EditorTheme): Extension => (theme === "dark" ? oneDark : theme === "oldschool" ? oldschool : []);

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
