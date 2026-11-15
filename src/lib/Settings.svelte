<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { settings, defaultIgnorePaths, type Theme, type Language } from "./prefs.svelte";
  import { t } from "./i18n.svelte";
  import { ACTIONS, DEFAULT_HOTKEYS, actionFor, comboOf, formatCombo, keyOf, type ActionId } from "./hotkeys";
  import { parsePath } from "./semantic";

  type Tab = "general" | "comparison" | "formatting" | "hotkeys" | "about";

  interface Props {
    tab?: Tab;
    /** Path of the project's .yad.yaml, when one applies. */
    project?: string | null;
    /** "Check for updates" in About. */
    oncheckupdate?: () => void;
    /** Forget recent comparisons. */
    onclearrecent?: () => void;
    onclose: () => void;
  }
  let { tab = $bindable("general"), project = null, oncheckupdate, onclearrecent, onclose }: Props = $props();

  const REPO = "https://github.com/pivnoebidlo/yad";
  let version = $state("");
  onMount(() => {
    getVersion().then((v) => (version = v)).catch(() => {});
  });

  // ---- comparison --------------------------------------------------------
  let ignoreText = $state(settings.ignorePaths.join("\n"));
  const invalid = $derived(ignoreText.split("\n").map((l) => l.trim()).filter((l) => l && !parsePath(l)));
  function onIgnoreInput() {
    settings.ignorePaths = ignoreText.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  function resetIgnore() {
    settings.ignorePaths = defaultIgnorePaths();
    ignoreText = settings.ignorePaths.join("\n");
  }

  // ---- hotkeys -------------------------------------------------------------
  /** Exported so the app can pause its own shortcuts while one is recorded. */
  let capturing = $state<ActionId | null>(null);
  export function isCapturing() {
    return capturing !== null;
  }
  let notice = $state("");

  function record(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === "Escape") return void (capturing = null);
    if (plain && (e.code === "Backspace" || e.code === "Delete")) {
      settings.hotkeys[capturing] = "";
      capturing = null;
      return;
    }
    const combo = comboOf(e);
    if (!combo) return; // a modifier on its own: keep listening
    const other = actionFor(combo, settings.hotkeys);
    if (other && other !== capturing) {
      settings.hotkeys[other] = "";
      notice = t("hotkeyTaken", { combo: formatCombo(combo), action: t(`a_${other}`) });
    } else notice = "";
    settings.hotkeys[capturing] = combo;
    capturing = null;
  }

  // ---- about: the easter egg -----------------------------------------------------
  // Typing the five characters n c \ n c (matched by physical key, any layout).
  const SECRET = ["N", "C", "\\", "N", "C"];
  let typed: string[] = [];
  let unlockedToast = $state(false);
  function secret(e: KeyboardEvent) {
    if (tab !== "about" || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = keyOf(e);
    if (!k) return;
    typed = [...typed, k].slice(-SECRET.length);
    if (typed.join() === SECRET.join()) {
      typed = [];
      settings.oldschool = true;
      settings.theme = "oldschool";
      unlockedToast = true;
      setTimeout(() => (unlockedToast = false), 4000);
    }
  }

  function onkey(e: KeyboardEvent) {
    if (capturing) return record(e);
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    secret(e);
  }

  const themes = $derived<Theme[]>(settings.oldschool ? ["system", "light", "dark", "oldschool"] : ["system", "light", "dark"]);
  const themeLabel = (th: Theme) =>
    ({ system: t("themeSystem"), light: t("themeLight"), dark: t("themeDark"), oldschool: t("themeOldschool") })[th];
  const languages: Language[] = ["system", "en", "ru"];
  const languageLabel = (l: Language) => ({ system: t("languageSystem"), en: "English", ru: "Русский" })[l];
  const tabs: Tab[] = ["general", "comparison", "formatting", "hotkeys", "about"];
</script>

<svelte:window onkeydowncapture={onkey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-modal="true" aria-label={t("settings")} tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <nav>
      {#each tabs as id}
        <button class:on={tab === id} onclick={() => (tab = id)}>{t(id)}</button>
      {/each}
    </nav>

    <div class="content">
      {#if tab === "general"}
        <label class="field">
          <span>{t("language")}</span>
          <select bind:value={settings.language}>
            {#each languages as l}<option value={l}>{languageLabel(l)}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t("theme")}</span>
          <select bind:value={settings.theme}>
            {#each themes as th}<option value={th}>{themeLabel(th)}</option>{/each}
          </select>
        </label>
        <label class="check top"><input type="checkbox" bind:checked={settings.restoreSession} /> {t("restoreSession")}</label>
        <p class="hint">{t("restoreSessionHint")}</p>
        {#if onclearrecent}<div><button onclick={onclearrecent}>{t("clearRecent")}</button></div>{/if}
        <label class="check top"><input type="checkbox" bind:checked={settings.autoUpdate} /> {t("autoUpdate")}</label>
        <p class="hint">{t("autoUpdateHint")}</p>
      {:else if tab === "comparison"}
        {#if project}<p class="project-note" title={project}>⚑ {t("projectSettingsNote")}</p>{/if}
        <label class="check"><input type="checkbox" bind:checked={settings.ignoreNoise} /> {t("ignoreNoise")}</label>
        <p class="hint">{t("ignoreNoiseHint")}</p>
        <textarea bind:value={ignoreText} oninput={onIgnoreInput} disabled={!settings.ignoreNoise} spellcheck="false" rows="10"></textarea>
        {#each invalid as bad}<p class="warn">{t("ignoreInvalid", { path: bad })}</p>{/each}
        <div><button onclick={resetIgnore}>{t("resetDefaults")}</button></div>
        <label class="check top"><input type="checkbox" bind:checked={settings.emptyEqualsMissing} /> {t("emptyEqualsMissing")}</label>
        <p class="hint">{t("emptyEqualsMissingHint")}</p>
        <label class="check top"><input type="checkbox" bind:checked={settings.crossNamespace} /> {t("crossNamespace")}</label>
        <p class="hint">{t("crossNamespaceHint")}</p>
        <label class="check top"><input type="checkbox" bind:checked={settings.pairRenamed} /> {t("pairRenamed")}</label>
        <p class="hint">{t("pairRenamedHint")}</p>
        <label class="check top"><input type="checkbox" bind:checked={settings.decodeSecrets} /> {t("decodeSecrets")}</label>
        <p class="hint">{t("decodeSecretsHint")}</p>
      {:else if tab === "formatting"}
        {#if project}<p class="project-note" title={project}>⚑ {t("projectSettingsNote")}</p>{/if}
        <p class="hint">{t("formatHint")}</p>
        <label class="field">
          <span>{t("indentSize")}</span>
          <select bind:value={settings.formatIndent}>
            {#each [2, 4] as n}<option value={n}>{t("indentSpaces", { n })}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t("seqStyle")}</span>
          <select bind:value={settings.formatIndentSeq}>
            <option value={true}>{t("seqIndented").replace("\n", " ")}</option>
            <option value={false}>{t("seqFlush").replace("\n", " ")}</option>
          </select>
        </label>
        <label class="check top"><input type="checkbox" bind:checked={settings.formatSortK8s} /> {t("sortK8sKeys")}</label>
        <p class="hint">{t("sortK8sKeysHint")}</p>
      {:else if tab === "hotkeys"}
        <p class="hint">{t("hotkeyHint")}</p>
        <div class="keys">
          {#each ACTIONS as id}
            <span class="action">{t(`a_${id}`)}</span>
            <button class="combo" class:capturing={capturing === id} class:empty={!settings.hotkeys[id]}
              onclick={() => { capturing = capturing === id ? null : id; notice = ""; }}>
              {capturing === id ? t("pressKeys") : settings.hotkeys[id] ? formatCombo(settings.hotkeys[id]) : t("notSet")}
            </button>
          {/each}
        </div>
        {#if notice}<p class="warn">{notice}</p>{/if}
        <div><button onclick={() => { settings.hotkeys = { ...DEFAULT_HOTKEYS }; notice = ""; }}>{t("resetAll")}</button></div>
      {:else}
        <div class="about">
          <div class="logo">YAD</div>
          <div class="name">YAML Ain't Different</div>
          {#if version}<div class="muted">{t("version", { v: version })}</div>{/if}
          <p>{t("aboutText")}</p>
          <p class="muted">{t("aboutAcronym")}</p>
          <div class="row">
            <button onclick={() => openUrl(REPO)}>GitHub</button>
            {#if oncheckupdate}<button onclick={oncheckupdate}>{t("checkUpdates")}</button>{/if}
          </div>
          {#if unlockedToast}<div class="toast">{t("oldschoolUnlocked")}</div>{/if}
        </div>
      {/if}
    </div>

    <button class="close" onclick={onclose} title={`${t("close")} (Esc)`}>✕</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: #0006; display: flex; align-items: center; justify-content: center; z-index: 100; }
  .dialog { position: relative; width: min(720px, calc(100vw - 32px)); height: min(520px, calc(100vh - 32px)); display: flex;
    background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: calc(var(--radius) * 2); overflow: hidden;
    box-shadow: 0 20px 60px #0005; }
  :global(:root[data-theme="oldschool"]) .dialog { border: 3px double var(--border); }
  nav { width: 170px; flex: none; display: flex; flex-direction: column; gap: 2px; padding: 12px 8px; background: var(--panel); border-right: 1px solid var(--border); }
  nav button { all: unset; padding: 6px 10px; border-radius: var(--radius); cursor: default; }
  nav button:hover { background: var(--hover); }
  nav button.on { background: var(--accent); color: var(--accent-text); }
  .content { flex: 1; min-width: 0; padding: 20px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .field { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 12px; }
  .field select { max-width: 240px; }
  .check { display: flex; gap: 8px; align-items: center; font-weight: 600; }
  .check.top { margin-top: 12px; }
  .project-note { margin: 0 0 4px; padding: 6px 8px; border-radius: 6px; background: var(--accent-soft); font-size: 12px; }
  .about .row { display: flex; gap: 8px; justify-content: center; }
  .hint { margin: 0; color: var(--muted); font-size: 12px; }
  .warn { margin: 0; color: var(--removed); font-size: 12px; }
  textarea { width: 100%; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 6px;
    background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); }
  textarea:disabled { opacity: 0.5; }
  .keys { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: center; }
  .combo { min-width: 120px; font-family: ui-monospace, Menlo, monospace; }
  .combo.empty { color: var(--muted); }
  .combo.capturing { outline: 2px solid var(--accent); }
  .about { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; margin-top: 16px; }
  .about p { max-width: 420px; margin: 6px 0; }
  .logo { font: 700 56px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; color: var(--accent); }
  :global(:root[data-theme="oldschool"]) .logo { color: #ffff55; }
  .name { font-size: 16px; font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }
  .toast { margin-top: 12px; padding: 6px 12px; background: #000; color: #55ff55; font-family: ui-monospace, Menlo, monospace; }
  .close { position: absolute; top: 8px; right: 8px; padding: 0 6px; background: none; border: none; color: var(--muted); font-size: 14px; }
  .close:hover { color: var(--text); }
</style>
