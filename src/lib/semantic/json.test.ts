/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyEdits, compareTexts, expandJsonStrings, isJsonText, planApply, type Direction } from "./index";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const allEqual = (a: string, b: string) => compareTexts(a, b).resources.every((r) => r.status === "equal");
function applyAll(a: string, b: string, dir: Direction) {
  const res = compareTexts(a, b);
  const target = dir === "a-to-b" ? b : a;
  const plan = planApply(res.resources.map((r) => ({ resource: r })), dir, target);
  expect(plan.errors).toEqual([]);
  return applyEdits(target, plan.edits);
}

describe("applying changes to JSON", () => {
  it("keeps a JSON target valid JSON with its own indentation", () => {
    const yamlManifest = fixture("manifest.yaml");
    const liveJson = JSON.stringify(parse(fixture("live.yaml")), null, 4) + "\n";
    expect(isJsonText(liveJson)).toBe(true);
    const out = applyAll(yamlManifest, liveJson, "a-to-b");
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toMatch(/\n {4}"apiVersion"/);
    expect(allEqual(yamlManifest, out)).toBe(true);
  });

  it("inserts, removes and moves array items", () => {
    const a = JSON.stringify({ steps: ["a", "b", "c", "d"], env: [{ name: "X", value: "1" }] }, null, 2);
    const b = JSON.stringify({ steps: ["d", "a", "c", "e"], env: [{ name: "Y", value: "2" }] }, null, 2);
    for (const dir of ["a-to-b", "b-to-a"] as const) {
      const out = applyAll(a, b, dir);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(dir === "a-to-b" ? allEqual(a, out) : allEqual(out, b)).toBe(true);
    }
  });

  it("does not treat YAML flow maps as JSON files", () => {
    expect(isJsonText("{a: 1}")).toBe(false);
    expect(isJsonText("a: 1")).toBe(false);
  });
});

describe("expanding JSON embedded in strings", () => {
  it("turns strings that hold JSON objects or arrays into real values, recursively", () => {
    const v = expandJsonStrings({
      request: "{\"obj\":{\"PhoneChange\":false}}",
      headers: "[\"gzip, deflate, br, zstd\"]",
      nested: "{\"inner\":\"{\\\"deep\\\":1}\"}",
      text: "{not json}",
      num: "42",
      flag: "true",
      quoted: "\"hello\"",
      empty: "{}",
      nul: "null",
      spaces: "  {\"a\":1}  ",
    }) as Record<string, unknown>;
    expect(v.request).toEqual({ obj: { PhoneChange: false } });
    expect(v.headers).toEqual(["gzip, deflate, br, zstd"]);
    expect(v.nested).toEqual({ inner: { deep: 1 } }); // JSON inside JSON inside a string
    expect(v.text).toBe("{not json}");
    expect(v.num).toBe("42");
    expect(v.flag).toBe("true");
    expect(v.quoted).toBe("\"hello\"");
    expect(v.empty).toEqual({});
    expect(v.nul).toBe("null");
    expect(v.spaces).toEqual({ a: 1 });
  });

  it("expands inside arrays and nested values, and leaves other types alone", () => {
    expect(expandJsonStrings({ list: ["{\"a\":1}", "plain"], deep: { x: "[{\"b\":2}]" } })).toEqual({
      list: [{ a: 1 }, "plain"],
      deep: { x: [{ b: 2 }] },
    });
    expect(expandJsonStrings([1, null, true, "x"])).toEqual([1, null, true, "x"]);
    expect(expandJsonStrings("not an object")).toBe("not an object");
  });
});
