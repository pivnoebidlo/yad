// Minimal CodeMirror setup: only what a diff editor needs, to keep the bundle small.
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
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
import type { Lang } from "./files";

export const languageExt = (lang: Lang): Extension =>
  lang === "yaml" ? yaml() : lang === "json" ? json() : [];

export const themeExt = (dark: boolean): Extension => (dark ? oneDark : []);

export function baseSetup(opts: {
  language: Compartment;
  theme: Compartment;
  lang: Lang;
  dark: boolean;
  onChange: () => void;
}): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
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
    opts.theme.of(themeExt(opts.dark)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange();
    }),
  ];
}
