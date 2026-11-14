import { describe, expect, it } from "vitest";
import { minimalEdit } from "./workspace";

const apply = (s: string, e: { from: number; to: number; insert: string }) => s.slice(0, e.from) + e.insert + s.slice(e.to);

describe("minimalEdit", () => {
  it("touches only the differing middle", () => {
    const a = "a: 1\nimage: x:1.4\nb: 2\n", b = "a: 1\nimage: x:1.5\nb: 2\n";
    const e = minimalEdit(a, b);
    expect(e).toEqual({ from: 16, to: 17, insert: "5" });
    expect(apply(a, e)).toBe(b);
  });
  it("handles insertions, deletions, empty and identical texts", () => {
    for (const [a, b] of [["abc", "abxyc"], ["abxyc", "abc"], ["", "new"], ["old", ""], ["same", "same"], ["aaa", "aa"]])
      expect(apply(a, minimalEdit(a, b))).toBe(b);
  });
});
