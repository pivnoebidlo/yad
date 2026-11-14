/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdits, compareTexts, formatPath, planApply, type Direction } from "./index";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Apply everything (or the changes whose path matches `only`) in `dir`, return the new target text. */
function apply(a: string, b: string, dir: Direction, only?: string): string {
  const res = compareTexts(a, b);
  const items = res.resources.flatMap((r) =>
    only === undefined ? [{ resource: r }] : r.changes.filter((c) => formatPath(c.path) === only).map((change) => ({ resource: r, change })),
  );
  const target = dir === "a-to-b" ? b : a;
  const plan = planApply(items, dir, target);
  expect(plan.errors).toEqual([]);
  return applyEdits(target, plan.edits);
}

const statuses = (a: string, b: string) => compareTexts(a, b).resources.map((r) => `${r.label}: ${r.status}`);

describe("planApply", () => {
  it("makes manifest and live output semantically equal in both directions", () => {
    const a = fixture("manifest.yaml"), b = fixture("live.yaml");
    const b2 = apply(a, b, "a-to-b");
    expect(statuses(a, b2).every((s) => s.endsWith("equal"))).toBe(true);
    const a2 = apply(a, b, "b-to-a");
    expect(statuses(a2, b).every((s) => s.endsWith("equal"))).toBe(true);
    // Untouched parts keep their formatting: flow-style args survive in the manifest.
    expect(a2).toContain('args: ["--port=8080", "--log=json"]');
    expect(a2).toContain("# What's in git");
  });

  it("replaces a scalar in place", () => {
    const a = "kind: X\nmetadata: {name: n}\nspec:\n  replicas: 2 # keep me\n  other: 1\n";
    const b = "kind: X\nmetadata: {name: n}\nspec:\n  replicas: 5 # keep me\n  other: 1\n";
    expect(apply(a, b, "b-to-a", "spec.replicas")).toBe(b);
  });

  it("inserts a keyed list item next to its source neighbours with correct indentation", () => {
    const a = `kind: X
metadata: {name: n}
env:
- name: A
  value: "1"
- name: B
  value: "2"
- name: C
  value: "3"
`;
    const b = `kind: X
metadata: {name: n}
env:
    -   name: A
        value: "1"
    -   name: C
        value: "3"
`;
    const out = apply(a, b, "a-to-b", "env[B]");
    expect(out).toBe(`kind: X
metadata: {name: n}
env:
    -   name: A
        value: "1"
    - name: B
      value: "2"
    -   name: C
        value: "3"
`);
    expect(statuses(a, out)).toEqual(["X n: equal"]);
  });

  it("inserts a map key after its preceding sibling", () => {
    const a = "kind: X\nmetadata:\n  name: n\n  namespace: prod\n  labels:\n    app: web\n";
    const b = "kind: X\nmetadata:\n  name: n\n  labels:\n    app: web\n";
    expect(apply(a, b, "a-to-b", "metadata.namespace")).toBe(a);
  });

  it("removes map keys and list items, including the first key of a list item", () => {
    const a = "kind: X\nmetadata: {name: n}\nitems:\n  - a: 1\n    b: 2\n  - c: 3\n";
    const b = "kind: X\nmetadata: {name: n}\nitems:\n  - b: 2\n  - c: 3\n";
    expect(apply(a, b, "b-to-a", "items[0].a")).toBe(b);
  });

  it("removes the last two items of a list (overlapping deletions are merged)", () => {
    const a = "kind: X\nmetadata: {name: n}\nports:\n  - {name: a, port: 1}\n  - {name: b, port: 2}\n  - {name: c, port: 3}\n";
    const b = "kind: X\nmetadata: {name: n}\nports:\n  - {name: a, port: 1}\n";
    const out = apply(a, b, "b-to-a");
    expect(out).toBe(b);
  });

  it("replaces an inline value with a block one and vice versa", () => {
    const a = "kind: X\nmetadata: {name: n}\nres: {}\nsel:\n  matchLabels:\n    app: web\n";
    const b = "kind: X\nmetadata: {name: n}\nres:\n  limits:\n    cpu: 1\nsel: none\n";
    const toA = apply(a, b, "b-to-a");
    expect(toA).toBe("kind: X\nmetadata: {name: n}\nres:\n  limits:\n    cpu: 1\nsel: none\n");
    const toB = apply(a, b, "a-to-b");
    expect(statuses(a, toB).every((s) => s.endsWith("equal"))).toBe(true);
    expect(toB).toContain("sel:\n  matchLabels:\n    app: web");
  });

  it("re-indents block scalars and nested blocks between different styles", () => {
    const a = "kind: ConfigMap\nmetadata: {name: n}\ndata:\n  conf: |\n    line1\n    line2\n";
    const b = "kind: ConfigMap\nmetadata: {name: n}\ndata:\n    conf: |\n        old\n";
    const out = apply(a, b, "a-to-b");
    // Content keeps its indentation relative to the key, as in the source.
    expect(out).toBe("kind: ConfigMap\nmetadata: {name: n}\ndata:\n    conf: |\n      line1\n      line2\n");
    expect(statuses(a, out)).toEqual(["ConfigMap n: equal"]);
  });

  it("fills an empty collection with several block items", () => {
    const a = "kind: X\nmetadata:\n  name: n\n  labels:\n    app: web\n    tier: be\n";
    const b = "kind: X\nmetadata:\n  name: n\n  labels: {}\n";
    expect(apply(a, b, "a-to-b")).toBe(a);
  });

  it("edits flow collections by rewriting them", () => {
    const a = "kind: X\nmetadata: {name: n}\nargs: [a, x, b]\nlabels: {app: web, tier: be}\n";
    const b = "kind: X\nmetadata: {name: n}\nargs: [a, b]\nlabels: {app: web}\n";
    const out = apply(a, b, "a-to-b");
    expect(statuses(a, out)).toEqual(["X n: equal"]);
    expect(out).toContain("metadata: {name: n}");
  });

  it("adds and removes whole resources", () => {
    const cm = (n: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${n}\n`;
    const a = [cm("one"), cm("two"), cm("three")].join("---\n");
    const b = `# header\n${cm("one")}---\n# about four\n${cm("four")}`;
    const out = apply(a, b, "a-to-b");
    expect(statuses(a, out).every((s) => s.endsWith("equal"))).toBe(true);
    expect(out.startsWith("# header\n")).toBe(true);
    expect(out).not.toContain("four");
  });

  it("removes and adds items of a kind: List", () => {
    const a = fixture("manifest.yaml");
    const b = fixture("live.yaml");
    const onlyService = a.slice(0, a.indexOf("---"));
    const out = apply(onlyService, b, "a-to-b");
    expect(statuses(onlyService, out).every((s) => s.endsWith("equal"))).toBe(true);
    expect(out).toContain("kind: List");
  });
});
