/**
 * App-level keyboard shortcuts: an action registry, layout-independent
 * matching (by physical key, so they work with any keyboard layout) and
 * display in the platform's style.
 */

export const ACTIONS = [
  "settings", "save", "saveAll",
  "openFileLeft", "openFileRight", "openFolderLeft", "openFolderRight",
  "modeSemantic", "modeSource", "showInSource", "toggleSidebar", "filter",
  "prevDiff", "nextDiff", "prevFile", "nextFile",
] as const;
export type ActionId = (typeof ACTIONS)[number];

/** Combos use "Mod" for Cmd on macOS and Ctrl elsewhere. */
export const DEFAULT_HOTKEYS: Record<ActionId, string> = {
  settings: "Mod+,",
  save: "Mod+S",
  saveAll: "Mod+Shift+S",
  openFileLeft: "Mod+O",
  openFileRight: "Mod+Shift+O",
  openFolderLeft: "Mod+Alt+O",
  openFolderRight: "Mod+Alt+Shift+O",
  modeSemantic: "Mod+1",
  modeSource: "Mod+2",
  showInSource: "Mod+J",
  toggleSidebar: "Mod+B",
  filter: "Mod+Shift+F",
  prevDiff: "Alt+ArrowUp",
  nextDiff: "Alt+ArrowDown",
  prevFile: "Mod+Alt+ArrowUp",
  nextFile: "Mod+Alt+ArrowDown",
};

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const CODE_KEYS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", Space: "Space",
};

/** The physical key of an event, independent of the keyboard layout. */
export function keyOf(e: Pick<KeyboardEvent, "code" | "key">): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^Numpad[0-9]$/.test(c)) return c.slice(6);
  if (c in CODE_KEYS) return CODE_KEYS[c];
  if (/^(Arrow(Up|Down|Left|Right)|F\d{1,2}|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown)$/.test(c)) return c;
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** "Mod+Alt+Shift+K" style combo for an event, or null for a bare modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  const key = keyOf(e);
  if (!key) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↩", Escape: "Esc",
  Backspace: "⌫", Delete: "⌦", Tab: "⇥", PageUp: "PgUp", PageDown: "PgDn",
};

/** Display a combo the way the platform does: "⌥⇧⌘O" on macOS, "Ctrl+Alt+Shift+O" elsewhere. */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  const parts = combo.split("+");
  const key = parts.pop()!;
  const label = KEY_LABELS[key] ?? key;
  if (isMac) {
    // macOS order: ⌃ ⌥ ⇧ ⌘
    const order = ["Ctrl", "Alt", "Shift", "Mod"];
    return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => MAC_SYMBOLS[p]).join("") + label;
  }
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), label].join("+");
}

/** Which action (if any) a combo triggers under the given bindings. */
export function actionFor(combo: string | null, bindings: Record<ActionId, string>): ActionId | null {
  if (!combo) return null;
  return (ACTIONS.find((a) => bindings[a] === combo) as ActionId | undefined) ?? null;
}
