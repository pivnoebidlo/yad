/** User settings, persisted in the webview's localStorage. */
import { DEFAULT_HOTKEYS, ACTIONS, type ActionId } from "./hotkeys";
import { DEFAULT_IGNORE, DEFAULT_MERGE_KEYS, formatPath, parsePath, type CompareOptions, type FormatOptions } from "./semantic";

export type Theme = "system" | "light" | "dark" | "oldschool";
export type Language = "system" | "en" | "ru";
export type Locale = "en" | "ru";

export interface Settings {
  language: Language;
  theme: Theme;
  /** The Oldschool theme has been unlocked (see About). */
  oldschool: boolean;
  hotkeys: Record<ActionId, string>;
  ignoreNoise: boolean;
  /** Ignore patterns, one per entry, in formatPath syntax. */
  ignorePaths: string[];
  emptyEqualsMissing: boolean;
  crossNamespace: boolean;
  /** Formatting ("Format" button). */
  formatIndent: number;
  formatIndentSeq: boolean;
  formatSortK8s: boolean;
}

const KEY = "yad.settings";

export const defaultIgnorePaths = () => DEFAULT_IGNORE.map((p) => formatPath(p));

export const defaultSettings = (): Settings => ({
  language: "system",
  theme: "system",
  oldschool: false,
  hotkeys: { ...DEFAULT_HOTKEYS },
  ignoreNoise: true,
  ignorePaths: defaultIgnorePaths(),
  emptyEqualsMissing: true,
  crossNamespace: true,
  formatIndent: 2,
  formatIndentSeq: true,
  formatSortK8s: true,
});

function load(): Settings {
  const d = defaultSettings();
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v === "object") {
      const hotkeys = { ...d.hotkeys };
      for (const a of ACTIONS) if (typeof v.hotkeys?.[a] === "string") hotkeys[a] = v.hotkeys[a];
      return { ...d, ...v, hotkeys, ignorePaths: Array.isArray(v.ignorePaths) ? v.ignorePaths : d.ignorePaths };
    }
  } catch {}
  return d;
}

export const settings = $state<Settings>(load());

/** Things the settings depend on that come from the system. */
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
export const env = $state({
  systemDark: darkQuery?.matches ?? false,
  systemLocale: (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase().startsWith("ru") ? "ru" : "en",
});
darkQuery?.addEventListener("change", (e) => (env.systemDark = e.matches));

$effect.root(() => {
  $effect(() => {
    const json = JSON.stringify(settings);
    try {
      localStorage.setItem(KEY, json);
    } catch {}
  });
});

export function effectiveTheme(): "light" | "dark" | "oldschool" {
  const t = settings.theme;
  if (t === "oldschool") return settings.oldschool ? "oldschool" : env.systemDark ? "dark" : "light";
  if (t === "light" || t === "dark") return t;
  return env.systemDark ? "dark" : "light";
}

export function effectiveLocale(): Locale {
  return settings.language === "system" ? (env.systemLocale as Locale) : settings.language;
}

export function compareOptions(): CompareOptions {
  return {
    ignore: settings.ignoreNoise ? settings.ignorePaths.map(parsePath).filter((p): p is string[] => !!p) : [],
    mergeKeys: { ...DEFAULT_MERGE_KEYS },
    fallbackMergeKeys: ["name"],
    emptyEqualsMissing: settings.emptyEqualsMissing,
    crossNamespace: settings.crossNamespace,
  };
}

export function formatOptions(): FormatOptions {
  return { indent: settings.formatIndent, indentSeq: settings.formatIndentSeq, sortKubernetesKeys: settings.formatSortK8s };
}
