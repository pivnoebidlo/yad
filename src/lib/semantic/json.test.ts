/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyEdits, compareTexts, isJsonText, planApply, type Direction } from "./index";

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
