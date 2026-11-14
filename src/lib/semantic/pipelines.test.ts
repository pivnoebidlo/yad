import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyEdits, compareTexts, detectKind, formatPath, planApply, type Direction } from "./index";

const gha = (steps: string) => `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}`;

const step = (name: string, run: string) => `      - name: ${name}\n        run: ${run}\n`;

function applyAll(a: string, b: string, dir: Direction) {
  const res = compareTexts(a, b);
  const target = dir === "a-to-b" ? b : a;
  const plan = planApply(res.resources.map((r) => ({ resource: r })), dir, target);
  expect(plan.errors).toEqual([]);
  return applyEdits(target, plan.edits);
}
const allEqual = (a: string, b: string) => compareTexts(a, b).resources.every((r) => r.status === "equal");

describe("detectKind", () => {
  it("recognizes common YAML documents", () => {
    expect(detectKind(parse("apiVersion: v1\nkind: Pod\nmetadata: {name: p}"))).toBe("kubernetes");
    expect(detectKind(parse(gha(step("a", "make"))))).toBe("github-actions");
    expect(detectKind(parse("stages: [build]\nbuild:\n  stage: build\n  script: [make]\n"))).toBe("gitlab-ci");
    expect(detectKind(parse("job:\n  image: node\n  script:\n    - npm test\n"))).toBe("gitlab-ci");
    expect(detectKind(parse("trigger: [main]\npool: {vmImage: ubuntu-latest}\nsteps:\n  - script: make\n"))).toBe("azure-pipelines");
    expect(detectKind(parse("- hosts: all\n  tasks:\n    - name: x\n      apt: {name: git}\n"))).toBe("ansible");
    expect(detectKind(parse("- name: install\n  ansible.builtin.apt: {name: git}\n"))).toBe("ansible");
    expect(detectKind(parse("services:\n  web:\n    image: nginx\n"))).toBe("compose");
    expect(detectKind(parse("replicaCount: 2\nimage: {tag: 1.0}\n"))).toBe("yaml");
  });
});

describe("pipelines: order of steps matters", () => {
  const a = gha(step("checkout", "git clone") + step("build", "make") + step("test", "make test"));
  const reordered = gha(step("checkout", "git clone") + step("test", "make test") + step("build", "make"));

  it("reports a reordered step as moved, not as equal", () => {
    const res = compareTexts(a, reordered);
    expect(res.resources[0].status).toBe("changed");
    const moved = res.resources[0].changes.filter((c) => c.kind === "moved");
    expect(moved).toHaveLength(1);
    expect(res.resources[0].changes.every((c) => c.kind === "moved")).toBe(true);
  });

  it("still keys Kubernetes lists by name", () => {
    const pod = (c: string) => `apiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  containers:\n${c}`;
    const c1 = "    - {name: a, image: x}\n", c2 = "    - {name: b, image: y}\n";
    expect(allEqual(pod(c1 + c2), pod(c2 + c1))).toBe(true);
  });

  it("applies moves in both directions and keeps formatting", () => {
    const withComment = reordered.replace("    steps:\n", "    steps:   # our steps\n");
    const toB = applyAll(a, withComment, "a-to-b");
    expect(allEqual(a, toB)).toBe(true);
    expect(toB).toContain("# our steps");
    const toA = applyAll(a, reordered, "b-to-a");
    expect(allEqual(toA, reordered)).toBe(true);
  });

  it("handles a step added at the top plus a changed step below it (different indexes per side)", () => {
    const b = gha(step("lint", "make lint") + step("checkout", "git clone") + step("build", "make -j8") + step("test", "make test"));
    const res = compareTexts(a, b);
    const changed = res.resources[0].changes.find((c) => c.kind === "changed")!;
    expect(formatPath(changed.path)).toBe("jobs.build.steps[2].run");
    expect(formatPath(changed.aPath!)).toBe("jobs.build.steps[1].run");
    expect(allEqual(a, applyAll(a, b, "a-to-b"))).toBe(true);
    expect(allEqual(applyAll(a, b, "b-to-a"), b)).toBe(true);
  });

  it("moves Ansible tasks", () => {
    const task = (n: string) => `- name: ${n}\n  ansible.builtin.command: echo ${n}\n`;
    const x = task("one") + task("two") + task("three");
    const y = task("three") + task("one") + task("two");
    expect(compareTexts(x, y).resources[0].changes.map((c) => c.kind)).toEqual(["moved"]);
    expect(allEqual(x, applyAll(x, y, "a-to-b"))).toBe(true);
  });
});
