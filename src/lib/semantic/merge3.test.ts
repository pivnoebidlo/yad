import { describe, expect, it } from "vitest";
import { compareTexts, formatPath, merge3, resolveConflict } from "./index";

const dep = (o: { replicas?: number; image?: string; env?: string; extra?: string } = {}) =>
  `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api # the API
  namespace: shop
spec:
  replicas: ${o.replicas ?? 2}
  template:
    spec:
      containers:
        - name: api
          image: ${o.image ?? "api:1.0"}
          env:
            - name: LOG
              value: ${o.env ?? "info"}
${o.extra ?? ""}`;

const equal = (a: string, b: string) => compareTexts(a, b, { ignore: [] }).resources.every((r) => r.status === "equal");

describe("merge3", () => {
  it("combines changes to different keys, keeping ours' formatting", () => {
    const base = dep();
    const ours = dep({ replicas: 6 }).replace("namespace: shop", "namespace:   shop   # prod");
    const theirs = dep({ image: "api:1.1", env: "debug" });
    const m = merge3(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.errors).toEqual([]);
    expect(m.applied).toBe(2);
    expect(equal(m.text, dep({ replicas: 6, image: "api:1.1", env: "debug" }))).toBe(true);
    expect(m.text).toContain("namespace:   shop   # prod");
    expect(m.text).toContain("# the API");
  });

  it("does not conflict when both sides made the same change or only reordered", () => {
    const base = "a: 1\nb: 2\nc: 3\n";
    const ours = "c: 3\nb: 2\na: 10\n";
    const theirs = "a: 10\nb: 2\nc: 3\nd: 4\n";
    const m = merge3(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(equal(m.text, "a: 10\nb: 2\nc: 3\nd: 4\n")).toBe(true);
    expect(m.text.startsWith("c: 3\n")).toBe(true); // ours' order kept
  });

  it("reports a conflict when both changed the same value, and keeps ours there", () => {
    const m = merge3(dep(), dep({ replicas: 3, env: "warn" }), dep({ replicas: 5, image: "api:2" }));
    expect(m.conflicts.map((c) => [formatPath(c.path!), c.base, c.ours, c.theirs])).toEqual([["spec.replicas", 2, 3, 5]]);
    expect(equal(m.text, dep({ replicas: 3, env: "warn", image: "api:2" }))).toBe(true);
    const theirs = resolveConflict(m.text, dep({ replicas: 5, image: "api:2" }), m.conflicts[0]);
    expect(theirs.errors).toEqual([]);
    expect(equal(theirs.text, dep({ replicas: 5, env: "warn", image: "api:2" }))).toBe(true);
  });

  it("conflicts when one side removed what the other changed", () => {
    const base = dep();
    const ours = dep().replace(/ {10}env:\n.*\n.*\n/, "");
    const m = merge3(base, ours, dep({ env: "debug" }));
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0].ours).toBeUndefined();
    expect(m.conflicts[0].theirs).toEqual([{ name: "LOG", value: "debug" }]);
  });

  it("adds and removes whole resources", () => {
    const cm = (n: string, v = "1") => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${n}\ndata:\n  x: "${v}"\n`;
    const base = `${cm("a")}---\n${cm("b")}`;
    const ours = `${cm("a", "2")}---\n${cm("b")}`;
    const theirs = `${cm("a")}---\n${cm("c")}`;
    const m = merge3(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(equal(m.text, `${cm("a", "2")}---\n${cm("c")}`)).toBe(true);

    const removedVsChanged = merge3(base, `${cm("a")}---\n${cm("b", "9")}`, cm("a"));
    expect(removedVsChanged.conflicts.map((c) => [c.label, c.path, c.theirs])).toEqual([["ConfigMap b", undefined, undefined]]);
  });

  it("merges keyed list items independently of their order", () => {
    const base = "kind: X\nmetadata: {name: n}\nenv:\n  - name: A\n    value: '1'\n  - name: B\n    value: '1'\n";
    const ours = "kind: X\nmetadata: {name: n}\nenv:\n  - name: B\n    value: '2'\n  - name: A\n    value: '1'\n";
    const theirs = "kind: X\nmetadata: {name: n}\nenv:\n  - name: A\n    value: '3'\n  - name: B\n    value: '1'\n  - name: C\n    value: '1'\n";
    const m = merge3(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.errors).toEqual([]);
    expect(equal(m.text, "kind: X\nmetadata: {name: n}\nenv: [{name: B, value: '2'}, {name: A, value: '3'}, {name: C, value: '1'}]\n")).toBe(true);
    expect(m.text.indexOf("name: B")).toBeLessThan(m.text.indexOf("name: A"));
  });

  it("reports parse errors instead of merging", () => {
    expect(merge3("a: 1\n", "a: [2\n", "a: 3\n").errors[0]).toMatch(/^ours, line \d+:/);
  });

  it("merges JSON", () => {
    const m = merge3('{"a": 1, "b": 1}', '{"a": 2, "b": 1}', '{"a": 1, "b": 3}');
    expect(m.conflicts).toEqual([]);
    expect(JSON.parse(m.text)).toEqual({ a: 2, b: 3 });
  });
});
