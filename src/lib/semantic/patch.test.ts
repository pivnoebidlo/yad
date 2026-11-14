/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdits, compareTexts, defaultOptions, formatPath, planApply, planRevert, planSemanticEdit, renderNormalized, type Direction } from "./index";

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

describe("planRevert", () => {
  const a = fixture("manifest.yaml");
  const b = fixture("live.yaml");

  /** Apply one change a→b; return the target before/after and what was touched. */
  function applyOne(path: string) {
    const res = compareTexts(a, b);
    const r = res.resources.find((x) => x.changes.some((c) => formatPath(c.path) === path))!;
    const c = r.changes.find((x) => formatPath(x.path) === path)!;
    const plan = planApply([{ resource: r, change: c }], "a-to-b", b);
    return { after: applyEdits(b, plan.edits), touched: [{ key: r.b!.key, path: c.path }] };
  }

  it("reverts an early apply after later unrelated edits", () => {
    const { after, touched } = applyOne("spec.template.spec.containers[web].image");
    expect(after).toContain("registry.local/web:1.4.0");
    // Later, unrelated edits in the same file.
    const later = after.replace("replicas: 3", "replicas: 7").replace("value: debug", "value: warn");
    const plan = planRevert(b, later, touched);
    expect(plan.errors).toEqual([]);
    const out = applyEdits(later, plan.edits);
    expect(out).toContain("registry.local/web:1.5.0");
    expect(out).toContain("replicas: 7");
    expect(out).toContain("value: warn");
  });

  it("reverts inserted and removed resources", () => {
    const cm = (n: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${n}\n`;
    const src = [cm("one"), cm("two")].join("---\n");
    const dst = [cm("one"), cm("old")].join("---\n");
    const res = compareTexts(src, dst);
    const two = res.resources.find((r) => r.label.endsWith("two"))!;
    const old = res.resources.find((r) => r.label.endsWith("old"))!;
    const plan = planApply([{ resource: two }, { resource: old }], "a-to-b", dst);
    const after = applyEdits(dst, plan.edits);
    expect(compareTexts(src, after).resources.every((r) => r.status === "equal")).toBe(true);
    const later = after.replace("name: one", "name: one\n  labels: {x: y}");
    const rev = planRevert(dst, later, [{ key: two.a!.key }, { key: old.b!.key }]);
    expect(rev.errors).toEqual([]);
    const out = applyEdits(later, rev.edits);
    expect(out).toContain("name: old");
    expect(out).not.toContain("name: two");
    expect(out).toContain("labels: {x: y}");
  });
});

describe("planSemanticEdit", () => {
  const raw = fixture("manifest.yaml");
  const norm = () => renderNormalized(compareTexts(raw, "").resources, defaultOptions()).a;

  it("carries edits of the normalized view over to the source, keeping its formatting", () => {
    const old = norm();
    const edited = old
      .replace("replicas: 2", "replicas: 3")
      .replace("            - name: LOG_LEVEL", "            - name: EXTRA\n              value: \"1\"\n            - name: LOG_LEVEL")
      .replace("          image: envoyproxy/envoy:v1.31\n", "          image: envoyproxy/envoy:v1.32\n");
    expect(edited).not.toBe(old);
    const plan = planSemanticEdit(old, edited, raw);
    expect(plan.errors).toEqual([]);
    const out = applyEdits(raw, plan.edits);
    expect(compareTexts(edited, out).resources.every((r) => r.status === "equal")).toBe(true);
    expect(out).toContain("# What's in git");
    expect(out).toContain('args: ["--port=8080", "--log=json"]');
    expect(out).toContain("replicas: 3");
  });

  it("adds and deletes whole resources", () => {
    const old = norm();
    const withCm = old + "---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: extra\n";
    const withoutService = withCm.replace(/---\n# Service web[\s\S]*?(?=---\n|$)/, "");
    const plan = planSemanticEdit(old, withoutService, raw);
    expect(plan.errors).toEqual([]);
    const out = applyEdits(raw, plan.edits);
    const st = compareTexts(withoutService, out).resources.map((r) => `${r.label}: ${r.status}`);
    expect(st.every((s) => s.endsWith("equal"))).toBe(true);
    expect(out).toContain("name: extra");
    expect(out).not.toContain("kind: Service");
  });

  it("waits while the edited text does not parse", () => {
    const old = norm();
    const plan = planSemanticEdit(old, old.replace("replicas: 2", "replicas: [2"), raw);
    expect(plan.edits).toEqual([]);
    expect(plan.parseError?.line).toBeGreaterThan(0);
  });
});
