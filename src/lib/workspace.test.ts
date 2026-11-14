import { describe, expect, it } from "vitest";
import { decodeText, encodeText, isDirty, minimalEdit, storeEditorText, type Entry } from "./workspace";

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

describe("decodeText / encodeText", () => {
  it("round-trips CRLF and BOM files", () => {
    for (const raw of ["a: 1\r\nb: 2\r\n", "\uFEFFa: 1\nb: 2\n", "\uFEFFx: 1\r\n", "plain\n", ""]) {
      const d = decodeText(raw);
      expect(d.text).not.toContain("\r");
      expect(d.text.startsWith("\uFEFF")).toBe(false);
      expect(encodeText(d)).toBe(raw);
    }
  });
});

describe("storeEditorText", () => {
  const file = (text: string) => ({ path: "/s/a.yaml", saved: text, text, exists: true, eol: "\r\n" as const, bom: false });

  it("updates an existing buffer in place and never replaces it", () => {
    const buf = file("a: 1\n");
    const e: Entry = { rel: "a.yaml", a: buf, status: "equal" };
    storeEditorText(e, "a", "a: 1\n", "/stage");
    expect(e.a).toBe(buf);
    expect(isDirty(e.a)).toBe(false);
    storeEditorText(e, "a", "a: 2\n", "/stage");
    expect(e.a).toBe(buf);
    expect(isDirty(e.a)).toBe(true);
  });

  it("creates a buffer for a missing file only when there is text and a folder", () => {
    const e: Entry = { rel: "x/a.yaml", b: file("a: 1\n"), status: "added" };
    storeEditorText(e, "a", "", "/stage");
    expect(e.a).toBeUndefined();
    storeEditorText(e, "a", "a: 1\n", null);
    expect(e.a).toBeUndefined();
    storeEditorText(e, "a", "a: 1\n", "/stage");
    expect(e.a).toMatchObject({ path: "/stage/x/a.yaml", exists: false, eol: "\r\n" });
  });
});
