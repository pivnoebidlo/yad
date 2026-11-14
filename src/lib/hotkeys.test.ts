import { describe, expect, it } from "vitest";
import { actionFor, comboOf, DEFAULT_HOTKEYS, keyOf } from "./hotkeys";

const ev = (code: string, key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("hotkeys", () => {
  it("uses the physical key, so a Russian layout still matches", () => {
    expect(keyOf(ev("KeyS", "ы"))).toBe("S");
    expect(keyOf(ev("Digit1", "!"))).toBe("1");
    expect(keyOf(ev("Comma", "б"))).toBe(",");
    expect(keyOf(ev("ShiftLeft", "Shift"))).toBeNull();
  });

  it("builds combos and finds actions", () => {
    const mod = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
    expect(comboOf(ev("KeyS", "ы", { ...mod, shiftKey: true }))).toBe("Mod+Shift+S");
    expect(actionFor("Mod+Shift+S", DEFAULT_HOTKEYS)).toBe("saveAll");
    expect(actionFor("Mod+Alt+ArrowDown", DEFAULT_HOTKEYS)).toBe("nextFile");
    expect(actionFor("Mod+K", DEFAULT_HOTKEYS)).toBeNull();
  });

  it("has no duplicate default bindings", () => {
    const combos = Object.values(DEFAULT_HOTKEYS);
    expect(new Set(combos).size).toBe(combos.length);
  });
});
