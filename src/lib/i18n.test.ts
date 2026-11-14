import { describe, expect, it } from "vitest";
import { missingKeys, t, tn } from "./i18n.svelte";
import { settings } from "./prefs.svelte";
import { ACTIONS } from "./hotkeys";

describe("i18n", () => {
  it("Russian has every English key, including all action names", () => {
    expect(missingKeys("ru")).toEqual([]);
    settings.language = "ru";
    for (const a of ACTIONS) expect(t(`a_${a}`)).not.toMatch(/^a_/);
  });

  it("uses Russian plural forms", () => {
    settings.language = "ru";
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => tn("differences", n))).toEqual([
      "1 различие", "2 различия", "5 различий", "11 различий", "21 различие", "22 различия", "25 различий",
    ]);
    settings.language = "en";
    expect([1, 2].map((n) => tn("differences", n))).toEqual(["1 difference", "2 differences"]);
  });

  it("fills placeholders", () => {
    settings.language = "en";
    expect(t("resourcesDiffer", { n: 2, total: 5 })).toBe("2 of 5 resources differ");
  });
});
