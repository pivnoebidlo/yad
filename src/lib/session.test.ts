import { beforeEach, describe, expect, it } from "vitest";
import { addFavorite, addRecent, clearRecent, loadFavorites, loadRecent, loadSession, pairTitle, removeFavorite, saveSession, type Source } from "./session";

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

  it("keeps favorites named, unique by pair; broken entries are dropped", () => {
    let fav = addFavorite([], { name: "stage", a: f("/s"), b: f("/p") });
    fav = addFavorite(fav, { name: "logs", a: f("/l1"), b: f("/l2") });
    fav = addFavorite(fav, { name: "staging", a: f("/s"), b: f("/p") }); // the same pair: rename
    expect(fav.map((x) => x.name)).toEqual(["staging", "logs"]);
    store.set(
      "yad.favorites",
      JSON.stringify([{ name: "", a: f("/q"), b: f("/z") }, { name: "x", a: { kind: "bogus", path: "/q" } as never, b: f("/z") }, { name: "ok", a: f("/1"), b: f("/2") }]),
    );
    expect(loadFavorites()).toEqual([{ name: "ok", a: f("/1"), b: f("/2") }]);
    expect(removeFavorite(fav, fav[1]).map((x) => x.name)).toEqual(["staging"]);
  });
});
