import { describe, expect, it } from "vitest";
import { compareTexts, formatText } from "./index";

const strictEqual = (a: string, b: string) =>
  compareTexts(a, b, { ignore: [], mergeKeys: {}, fallbackMergeKeys: [], emptyEqualsMissing: false }).resources.every((r) => r.status === "equal");

describe("formatText", () => {
  it("cleans up a messy manifest: indentation, extra spaces, key order; keeps comments", () => {
    const messy = [
      "# Production API   ",
      "kind:   Deployment",
      "metadata:",
      "    labels:",
      "        app:    api   # the app",
      "    name: api",
      "apiVersion: apps/v1",
      "spec:",
      "    replicas:  3",
      "",
      "",
      "",
      "    template:",
      "        spec:",
      "            containers:",
      "            -   image:   nginx:1.27",
      "                name: web",
      "                args:   [\"--port=80\",  \"--v\"]",
      "",
    ].join("\n");
    const r = formatText(messy);
    expect(r.error).toBeUndefined();
    const out = r.text!;
    expect(strictEqual(messy, out)).toBe(true);
    expect(out).toBe([
      "# Production API",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "  labels:",
      "    app: api # the app",
      "spec:",
      "  replicas: 3",
      "",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: web",
      "          image: nginx:1.27",
      '          args: ["--port=80", "--v"]',
      "",
    ].join("\n"));
    expect(formatText(out).text).toBe(out); // idempotent
  });

  it("never reorders a pipeline: keys and steps stay where they are", () => {
    const pipeline = [
      "name:   CI",
      "on:  [push]",
      "jobs:",
      "    build:",
      "        runs-on:    ubuntu-latest",
      "        steps:",
      "        -   run:   make   ",
      "            name: build",
      "        -   name: test",
      "            run: make test",
      "",
    ].join("\n");
    const out = formatText(pipeline).text!;
    expect(strictEqual(pipeline, out)).toBe(true);
    expect(out).toBe([
      "name: CI",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: make",
      "        name: build",
      "      - name: test",
      "        run: make test",
      "",
    ].join("\n"));
  });

  it("keeps block scalars, quotes, anchors and multiple documents", () => {
    const src = [
      "# leading comment",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata: {name: c}",
      "data:",
      "  script: |",
      "    #!/bin/sh",
      "    echo  'two  spaces stay'",
      "  quoted:   \"yes\"",
      "  base: &b   value",
      "  copy: *b",
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: s",
      "",
    ].join("\n");
    const out = formatText(src).text!;
    expect(strictEqual(src, out)).toBe(true);
    expect(out).toContain("    echo  'two  spaces stay'");
    expect(out).toContain('quoted: "yes"');
    expect(out).toContain("&b value");
    expect(out).toContain("\n---\n");
    expect(out.startsWith("# leading comment\n")).toBe(true);
  });

  it("pretty-prints JSON and can order Kubernetes keys", () => {
    const out = formatText('{"kind":"Pod","metadata":{"name":"p"},"apiVersion":"v1","spec":{"containers":[{"image":"x","name":"a"}]}}').text!;
    expect(out).toBe(
      '{\n  "apiVersion": "v1",\n  "kind": "Pod",\n  "metadata": {\n    "name": "p"\n  },\n  "spec": {\n    "containers": [\n      {\n        "name": "a",\n        "image": "x"\n      }\n    ]\n  }\n}\n',
    );
    const plain = formatText('{"b":1,"a":[1,2]}').text!;
    expect(plain).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });

  it("pretty-prints a log line, expanding JSON embedded in string values", () => {
    const line = JSON.stringify({ code: 403, request: "{\"obj\":{\"PhoneChange\":false}}", request_headers: "[\"gzip\"]" });
    const r = formatText(line);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe(
      JSON.stringify({ code: 403, request: { obj: { PhoneChange: false } }, request_headers: ["gzip"] }, null, 2) + "\n",
    );
    // Idempotent: nothing left to expand.
    expect(formatText(r.text!).text).toBe(r.text);

    const off = formatText(line, { indent: 2, indentSeq: true, sortKubernetesKeys: true, expandNestedJson: false });
    expect(off.text).toBe(
      JSON.stringify({ code: 403, request: "{\"obj\":{\"PhoneChange\":false}}", request_headers: "[\"gzip\"]" }, null, 2) + "\n",
    );
  });

  it("can keep the original key order and the other sequence style", () => {
    const out = formatText("kind: Pod\napiVersion: v1\nmetadata: {name: p}\nspec:\n  containers:\n  - name: a\n", {
      indent: 2, indentSeq: false, sortKubernetesKeys: false,
    }).text!;
    expect(out).toBe("kind: Pod\napiVersion: v1\nmetadata: {name: p}\nspec:\n  containers:\n  - name: a\n");
  });

  it("refuses broken YAML", () => {
    expect(formatText("a: [1, 2\n").error).toBeTruthy();
  });
});
