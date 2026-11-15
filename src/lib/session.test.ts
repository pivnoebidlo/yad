import { beforeEach, describe, expect, it } from "vitest";
import { addRecent, clearRecent, loadRecent, loadSession, pairTitle, saveSession, type Source } from "./session";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  } as Storage;
});

const f = (path: string, kind: Source["kind"] = "file"): Source => ({ kind, path });

describe("session and recent comparisons", () => {
  it("names tabs by both sides, with folders when the names are the same", () => {
    expect(pairTitle(null, null, "New tab")).toBe("New tab");
    expect(pairTitle(f("/x/stage", "dir"), f("/x/prod", "dir"), "")).toBe("stage ↔ prod");
    expect(pairTitle(f("/e/stage/api.yaml"), f("/e/prod/api.yaml"), "")).toBe("api.yaml (stage ↔ prod)");
    expect(pairTitle(f("/e/a.yaml"), null, "")).toBe("a.yaml");
  });

  it("keeps the session, dropping broken entries", () => {
    expect(loadSession()).toBeNull();
    saveSession([{ a: f("/a"), b: f("/b") }, { a: null, b: null }, { a: { kind: "bogus", path: "/x" } as never, b: f("/c") }], 5);
    expect(loadSession()).toEqual({ tabs: [{ a: f("/a"), b: f("/b") }, { a: null, b: f("/c") }], active: 1 });
    store.set("yad.session", "{not json");
    expect(loadSession()).toBeNull();
  });

  it("keeps recent pairs unique, newest first, at most 20", () => {
    let r = addRecent([], f("/a"), f("/b"), 1);
    r = addRecent(r, f("/c"), f("/d"), 2);
    r = addRecent(r, f("/a"), f("/b"), 3);
    expect(r.map((x) => [x.a.path, x.at])).toEqual([["/a", 3], ["/c", 2]]);
    for (let i = 0; i < 30; i++) r = addRecent(r, f(`/p${i}`), f("/q"), 10 + i);
    expect(loadRecent()).toHaveLength(20);
    expect(clearRecent()).toEqual([]);
    expect(loadRecent()).toEqual([]);
  });
});
