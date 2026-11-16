import { describe, expect, it } from "vitest";
import { lineOf, lineStarts, splitChunk } from "./chunkParts";

describe("splitChunk", () => {
  it("keeps sibling changes together and separates an unrelated one", () => {
    // requests.cpu / requests.memory changed, then secretMounts removed (left only).
    const parts = splitChunk([
      { item: "cpu", group: "values.resources.requests", a: 0, b: 0 },
      { item: "memory", group: "values.resources.requests", a: 1, b: 1 },
      { item: "secretMounts", group: "values", a: 2 },
    ]);
    expect(parts).toEqual([
      { items: ["cpu", "memory"], side: "b", line: 0 },
      { items: ["secretMounts"], side: "a", line: 2 },
    ]);
  });

  it("anchors a change at its lower side so arrows do not overlap", () => {
    // Right: + timeoutSeconds, then replicaCount; left: replicaCount on the first line.
    const parts = splitChunk([
      { item: "replicaCount", group: "values", a: 0, b: 1 },
      { item: "timeoutSeconds", group: "values.readinessProbe", b: 0 },
    ]);
    expect(parts).toEqual([
      { items: ["timeoutSeconds"], side: "b", line: 0 },
      { items: ["replicaCount"], side: "b", line: 1 },
    ]);
  });

  it("merges different groups that start on the same row", () => {
    const parts = splitChunk([
      { item: "x", group: "p", a: 0 },
      { item: "y", group: "q", b: 0 },
    ]);
    expect(parts).toEqual([{ items: ["x", "y"], side: "a", line: 0 }]);
  });
});

describe("lineOf", () => {
  it("finds 0-based lines", () => {
    const s = lineStarts("ab\ncd\n\nef");
    expect([0, 2, 3, 5, 6, 7, 9].map((p) => lineOf(s, p))).toEqual([0, 0, 1, 1, 2, 3, 3]);
  });
});
