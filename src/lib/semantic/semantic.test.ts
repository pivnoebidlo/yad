/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareTexts, formatPath, parsePath, renderNormalized, defaultOptions, DEFAULT_IGNORE, type CompareResult } from "./index";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Compact view of all changes: "Kind ns/name: path kind". */
function summary(res: CompareResult): string[] {
  return res.resources.flatMap((r) =>
    r.changes.length
      ? r.changes.map((c) => `${r.label}: ${formatPath(c.path)} ${c.kind}`)
      : [`${r.label}: ${r.status}`],
  );
}

const deploy = (body: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
${body}`;

describe("compareTexts", () => {
  it("ignores key order", () => {
    const a = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c, namespace: x}\ndata: {a: '1', b: '2'}\n";
    const b = "kind: ConfigMap\ndata: {b: '2', a: '1'}\nmetadata: {namespace: x, name: c}\napiVersion: v1\n";
    expect(summary(compareTexts(a, b))).toEqual(["ConfigMap x/c: equal"]);
  });

  it("reports changed scalars with paths and source lines", () => {
    const a = deploy("  replicas: 2\n  paused: false\n");
    const b = deploy("  paused: false\n  replicas: 3\n");
    const [r] = compareTexts(a, b).resources;
    expect(r.status).toBe("changed");
    expect(r.changes).toHaveLength(1);
    const c = r.changes[0];
    expect(formatPath(c.path)).toBe("spec.replicas");
    expect([c.a, c.b]).toEqual([2, 3]);
    expect(c.aRange?.line).toBe(6);
    expect(c.bRange?.line).toBe(7);
    expect(a.slice(c.aRange!.from, c.aRange!.to)).toBe("2");
  });

  it("matches keyed list items regardless of order", () => {
    const a = deploy(`  template:
    spec:
      containers:
        - name: app
          image: app:1
          env:
            - {name: A, value: "1"}
            - {name: B, value: "2"}
        - name: side
          image: side:1
`);
    const b = deploy(`  template:
    spec:
      containers:
        - name: side
          image: side:1
        - name: app
          image: app:1
          env:
            - {name: B, value: "2"}
            - {name: C, value: "3"}
            - {name: A, value: "1"}
`);
    expect(summary(compareTexts(a, b))).toEqual([
      "Deployment web: spec.template.spec.containers[app].env[C] added",
    ]);
  });

  it("keeps order for unkeyed lists and aligns insertions", () => {
    const a = deploy("  args: [--a, --b, --c]\n");
    const b = deploy("  args: [--a, --x, --b, --c]\n");
    const reordered = deploy("  args: [--c, --b, --a]\n");
    expect(summary(compareTexts(a, b))).toEqual(["Deployment web: spec.args[1] added"]);
    expect(compareTexts(a, reordered).resources[0].status).toBe("changed");
  });

  it("falls back to positional diff when the merge key is not unique", () => {
    const a = deploy("  ports:\n    - {containerPort: 53, protocol: TCP}\n    - {containerPort: 53, protocol: UDP}\n");
    const b = deploy("  ports:\n    - {containerPort: 53, protocol: TCP}\n    - {containerPort: 53, protocol: SCTP}\n");
    expect(summary(compareTexts(a, b))).toEqual(["Deployment web: spec.ports[1].protocol changed"]);
  });

  it("matches resources across documents by identity, not position", () => {
    const cm = (n: string, v: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: ${n}}\ndata: {v: "${v}"}\n`;
    const a = [cm("one", "1"), cm("two", "2"), cm("gone", "0")].join("---\n");
    const b = [cm("new", "9"), cm("two", "2"), cm("one", "11")].join("---\n");
    expect(summary(compareTexts(a, b))).toEqual([
      "ConfigMap gone: removed",
      "ConfigMap new: added",
      "ConfigMap one: data.v changed",
      "ConfigMap two: equal",
    ]);
  });

  it("treats same name in different namespaces as different resources when crossNamespace is off", () => {
    const cm = (ns: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c, namespace: ${ns}}\n`;
    expect(summary(compareTexts(cm("a"), cm("b"), { crossNamespace: false }))).toEqual(["ConfigMap a/c: removed", "ConfigMap b/c: added"]);
  });

  it("compares a git manifest with kubectl live output, hiding server noise", () => {
    const res = compareTexts(fixture("manifest.yaml"), fixture("live.yaml"));
    expect(summary(res)).toEqual([
      "Deployment web: metadata.namespace added",
      "Deployment web: spec.replicas changed",
      "Deployment web: spec.template.spec.containers[web].image changed",
      "Deployment web: spec.template.spec.containers[web].env[LOG_LEVEL].value changed",
      "Service web: metadata.namespace added",
    ]);
    const image = res.resources[0].changes[2];
    expect([image.a, image.b]).toEqual(["registry.local/web:1.4.0", "registry.local/web:1.5.0"]);
    expect(image.aRange?.line).toBe(32);
    expect(image.bRange?.line).toBe(44);
  });

  it("can turn noise filtering off", () => {
    const res = compareTexts(fixture("manifest.yaml"), fixture("live.yaml"), { ignore: [] });
    const paths = res.resources.flatMap((r) => r.changes.map((c) => formatPath(c.path)));
    expect(paths).toContain("status");
    expect(paths).toContain("metadata.managedFields");
  });

  it("treats JSON and YAML with the same content as equal", () => {
    const yaml = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ntype: Opaque\ndata:\n  k: dg==\n";
    const json = '{"kind":"Secret","apiVersion":"v1","type":"Opaque","metadata":{"name":"s"},"data":{"k":"dg=="}}';
    expect(summary(compareTexts(yaml, json))).toEqual(["Secret s: equal"]);
  });

  it("treats empty collections as missing unless disabled", () => {
    const a = deploy("  replicas: 1\n");
    const b = deploy("  replicas: 1\n  template: {metadata: {annotations: {}}, spec: {volumes: []}}\n");
    expect(compareTexts(a, b).resources[0].status).toBe("equal");
    expect(summary(compareTexts(a, b, { emptyEqualsMissing: false }))).toEqual(["Deployment web: spec.template added"]);
  });

  it("distinguishes types: string '1' vs number 1", () => {
    const res = compareTexts(deploy('  x: "1"\n'), deploy("  x: 1\n"));
    expect(res.resources[0].changes[0]).toMatchObject({ kind: "changed", a: "1", b: 1 });
  });

  it("resolves aliases", () => {
    const a = "base: &b {cpu: 1, mem: 2}\nuse: *b\n";
    const b = "base: {cpu: 1, mem: 2}\nuse: {mem: 2, cpu: 1}\n";
    expect(compareTexts(a, b).resources[0].status).toBe("equal");
  });

  it("compares non-k8s documents by position and does not apply k8s ignores", () => {
    const res = compareTexts("status: ok\nn: 1\n---\nx: 1\n", "n: 1\nstatus: fail\n---\nx: 2\n");
    expect(summary(res)).toEqual(["Document 1: status changed", "Document 2: x changed"]);
  });

  it("skips empty documents and reports parse errors with lines", () => {
    const a = "---\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\n";
    expect(compareTexts(a, a).resources).toHaveLength(1);
    const bad = compareTexts("a: 1\nb: [1, 2\n", "a: 1\n");
    expect(bad.errors.a.length).toBeGreaterThan(0);
    expect(bad.errors.a[0].line).toBeGreaterThan(0);
    expect(bad.errors.b).toEqual([]);
  });
});

describe("renderNormalized", () => {
  it("produces identical text for semantically equal inputs", () => {
    const res = compareTexts(
      fixture("manifest.yaml").replace("replicas: 2", "replicas: 3").replace("1.4.0", "1.5.0")
        .replace(/value: info/, "value: debug").replace(/name: web\n  labels/, "name: web\n  namespace: prod\n  labels")
        .replace(/kind: Service\nmetadata:\n  name: web/, "kind: Service\nmetadata:\n  name: web\n  namespace: prod"),
      fixture("live.yaml"),
    );
    expect(summary(res).every((s) => s.endsWith("equal"))).toBe(true);
    const { a, b } = renderNormalized(res.resources, defaultOptions());
    expect(a).toBe(b);
  });

  it("puts well-known keys first, sorts keyed lists, drops noise", () => {
    const res = compareTexts(fixture("live.yaml"), "");
    const { a } = renderNormalized(res.resources, defaultOptions());
    expect(a.startsWith("# Deployment prod/web\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: prod\n  labels:\n")).toBe(true);
    expect(a).toContain("- name: web\n          image: registry.local/web:1.5.0\n");
    for (const noise of ["managedFields", "uid:", "status:", "annotations", "creationTimestamp"])
      expect(a).not.toContain(noise);
    // containers come out sorted by name: sidecar before web
    expect(a.indexOf("- name: sidecar")).toBeGreaterThan(0);
    expect(a.indexOf("- name: sidecar")).toBeLessThan(a.indexOf("- name: web"));
    // env sorted by name: DB_HOST before LOG_LEVEL
    expect(a.indexOf("name: DB_HOST")).toBeLessThan(a.indexOf("name: LOG_LEVEL"));
  });
});

describe("NormalizedView.locate", () => {
  it("finds resources and paths in normalized text on both sides", () => {
    const res = compareTexts(fixture("manifest.yaml"), fixture("live.yaml"));
    const view = renderNormalized(res.resources, defaultOptions());
    const dep = res.resources.find((r) => r.label.startsWith("Deployment"))!;
    const image = dep.changes.find((c) => formatPath(c.path).endsWith("image"))!;
    const ra = view.locate("a", dep.key, image.path)!;
    const rb = view.locate("b", dep.key, image.path)!;
    expect(view.a.slice(ra.from, ra.to)).toBe("image: registry.local/web:1.4.0");
    expect(view.b.slice(rb.from, rb.to)).toBe("image: registry.local/web:1.5.0");
    const ns = dep.changes.find((c) => formatPath(c.path) === "metadata.namespace")!;
    const nb = view.locate("b", dep.key, ns.path)!;
    expect(view.b.slice(nb.from, nb.to)).toBe("namespace: prod");
    // Missing on the left: falls back to the deepest existing pair (metadata).
    expect(view.a.slice(view.locate("a", dep.key, ns.path)!.from).startsWith("metadata:\n  name: web")).toBe(true);
    expect(view.locate("a", "nope")).toBeUndefined();
  });
});

describe("NormalizedView.pathAt", () => {
  it("maps a position in normalized text back to resource and path", () => {
    const res = compareTexts(fixture("manifest.yaml"), fixture("live.yaml"));
    const view = renderNormalized(res.resources, defaultOptions());
    const at = (side: "a" | "b", needle: string) => {
      const p = view.pathAt(side, view[side].indexOf(needle) + 2)!;
      return `${p.key} ${formatPath(p.path)}`;
    };
    expect(at("b", "registry.local/web:1.5.0")).toBe("apps/Deployment//web spec.template.spec.containers[web].image");
    expect(at("a", "value: info")).toBe("apps/Deployment//web spec.template.spec.containers[web].env[LOG_LEVEL].value");
    expect(at("a", "targetPort")).toBe("/Service//web spec.ports[80].targetPort");
    expect(at("a", "# Service web")).toBe("/Service//web ");
  });
});

describe("formatPath", () => {
  it("formats keys, indexes and keyed items", () => {
    expect(
      formatPath(["metadata", "annotations", "example.com/x", "spec", 0, { key: "name", value: "web" }]),
    ).toBe('metadata.annotations["example.com/x"].spec[0][web]');
  });
});

describe("parsePath", () => {
  it("round-trips formatPath for ignore patterns", () => {
    for (const p of DEFAULT_IGNORE) expect(parsePath(formatPath(p))).toEqual(p);
    expect(parsePath('metadata.annotations["a.b/c"]')).toEqual(["metadata", "annotations", "a.b/c"]);
    expect(parsePath("spec.*.status")).toEqual(["spec", "*", "status"]);
  });
  it("rejects malformed input", () => {
    for (const bad of ["", ".a", "a..b", 'a["x]', "a[1]"]) expect(parsePath(bad)).toBeNull();
  });
});

describe("matching across namespaces", () => {
  const dep = (ns: string, replicas: number) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: ${ns}\nspec:\n  replicas: ${replicas}\n`;
  it("pairs the same resource in different namespaces when unambiguous", () => {
    const r = compareTexts(dep("shop-stage", 1), dep("shop-prod", 6));
    expect(r.resources).toHaveLength(1);
    expect(r.resources[0].changes.map((c) => formatPath(c.path)).sort()).toEqual(["metadata.namespace", "spec.replicas"]);
  });
  it("does not guess when several namespaces have it", () => {
    const r = compareTexts(`${dep("a", 1)}---\n${dep("b", 1)}`, dep("c", 1));
    expect(r.resources.filter((x) => x.a && x.b)).toHaveLength(0);
  });
  it("still prefers the exact namespace", () => {
    const r = compareTexts(`${dep("a", 1)}---\n${dep("b", 2)}`, dep("b", 3));
    const paired = r.resources.filter((x) => x.a && x.b);
    expect(paired).toHaveLength(1);
    expect(paired[0].changes.map((c) => formatPath(c.path))).toEqual(["spec.replicas"]);
  });
});

describe("lessons from real overlays", () => {
  const summary2 = (a: string, b: string, o = {}) =>
    compareTexts(a, b, o).resources.map((r) => `${r.label}: ${r.status === "changed" ? r.changes.map((c) => formatPath(c.path)).join(", ") : r.status}`);

  it("compares files with a repeated key using the last one, with a warning", () => {
    const a = "s3:\n  buckets: [a]\n  url: x\n  buckets: [b]\n";
    const res = compareTexts(a, "s3:\n  buckets: [c]\n  url: x\n");
    expect(res.errors.a).toEqual([]);
    expect(res.warnings.a).toEqual([{ line: 4, message: 'duplicate key "buckets": the one at line 2 is ignored' }]);
    expect(res.resources[0].changes.map((c) => [formatPath(c.path), c.a, c.b])).toEqual([["s3.buckets[0]", "b", "c"]]);
  });

  it("pairs a renamed resource when it is the only one of its kind and the names are related", () => {
    const es = (n: string, mem: string) => `apiVersion: elasticsearch.k8s.elastic.co/v1\nkind: Elasticsearch\nmetadata:\n  name: ${n}\nspec:\n  memory: ${mem}\n`;
    expect(summary2(es("elk-stage", "4Gi"), es("elk-prod", "6Gi"))).toEqual(["Elasticsearch elk-stage → elk-prod: metadata.name, spec.memory"]);
    expect(summary2(es("elk-stage", "4Gi"), es("elk-prod", "6Gi"), { pairRenamed: false })).toEqual([
      "Elasticsearch elk-prod: added", "Elasticsearch elk-stage: removed",
    ]);
    // Unrelated names are a removal plus an addition, not a rename.
    expect(summary2(es("search", "4Gi"), es("logs", "4Gi"))).toEqual(["Elasticsearch logs: added", "Elasticsearch search: removed"]);
  });

  it("matches list items by id when names repeat", () => {
    const l = (items: string[]) =>
      `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\nvalues:\n  types:\n${items.map((i) => `    - {id: "${i}", name: same}`).join("\n")}\n`;
    expect(summary2(l(["01", "02", "03"]), l(["01", "03"]))).toEqual(["ConfigMap c: values.types[02]"]);
  });
});
