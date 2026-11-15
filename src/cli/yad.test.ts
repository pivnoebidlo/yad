/// <reference types="node" />
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./yad";

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "yad-cli-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(...argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), color: false });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const dep = (replicas: number, extra = "") =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: shop\nspec:\n  replicas: ${replicas}\n${extra}`;

describe("yad-cli diff", () => {
  it("exits 0 for files that differ only in order", () => {
    const d = tree({ "a.yaml": "a: 1\nb: 2\n", "b.yaml": "b: 2\na:   1\n" });
    const r = run("diff", join(d, "a.yaml"), join(d, "b.yaml"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("order/formatting only");
    expect(run("diff", "--order-matters", "-q", join(d, "a.yaml"), join(d, "b.yaml")).code).toBe(1);
  });

  it("reports semantic changes and exits 1", () => {
    const d = tree({ "l.yaml": dep(2), "r.yaml": dep(6) });
    const r = run("diff", join(d, "l.yaml"), join(d, "r.yaml"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("~ Deployment shop/api");
    expect(r.out).toContain("spec.replicas: 2 → 6");
  });

  it("compares folders and lists one-sided files", () => {
    const l = tree({ "app/d.yaml": dep(1), "only-left.yaml": "x: 1\n", "same.yaml": "a: 1\n" });
    const r = tree({ "app/d.yaml": dep(1), "only-right.json": "{\"x\": 1}", "same.yaml": "a: 1\n" });
    const res = run("diff", l, r);
    expect(res.code).toBe(1);
    expect(res.out).toContain("only-left.yaml: only on the left");
    expect(res.out).toContain("only-right.json: only on the right");
    expect(res.out).toMatch(/0 differ, 1 only right, 1 only left, 2 identical/);
  });

  it("produces JSON and Markdown reports", () => {
    const d = tree({ "l.yaml": dep(2), "r.yaml": dep(6) });
    const json = JSON.parse(run("diff", "--output", "json", join(d, "l.yaml"), join(d, "r.yaml")).out);
    expect(json.files[0].resources[0].changes).toEqual([{ path: "spec.replicas", kind: "changed", left: 2, right: 6 }]);
    const mdOut = run("diff", "--output=markdown", join(d, "l.yaml"), join(d, "r.yaml")).out;
    expect(mdOut).toContain("| `spec.replicas` | `2` | `6` |");
  });

  it("honours --ignore and exits 2 on invalid YAML or bad usage", () => {
    const d = tree({ "l.yaml": dep(2), "r.yaml": dep(6), "bad.yaml": "a: [1\n" });
    expect(run("diff", "--ignore", "spec.replicas", join(d, "l.yaml"), join(d, "r.yaml")).code).toBe(0);
    expect(run("diff", join(d, "l.yaml"), join(d, "bad.yaml")).code).toBe(2);
    expect(run("diff", join(d, "l.yaml")).code).toBe(2);
    expect(run("diff", "--bogus", join(d, "l.yaml"), join(d, "r.yaml")).err).toContain("unknown option --bogus");
    expect(run("diff", d, join(d, "l.yaml")).code).toBe(2);
  });
});

describe("yad-cli format", () => {
  it("checks by default and rewrites with --write, keeping CRLF", () => {
    const d = tree({ "ok.yaml": "a: 1\n", "messy.yaml": "kind:    Deployment\r\napiVersion: apps/v1\r\nmetadata:\r\n  name: x   \r\n" });
    const check = run("format", d);
    expect(check.code).toBe(1);
    expect(check.out).toContain("needs formatting");
    expect(check.out).toContain("messy.yaml");
    expect(run("format", "--write", d).code).toBe(0);
    expect(readFileSync(join(d, "messy.yaml"), "utf8")).toBe("apiVersion: apps/v1\r\nkind: Deployment\r\nmetadata:\r\n  name: x\r\n");
    expect(run("format", d).code).toBe(0);
  });
});

describe("yad-cli git-diff", () => {
  it("speaks git's external diff protocol, including added files", () => {
    const d = tree({ "old.yaml": dep(2), "new.yaml": dep(6) });
    const r = run("git-diff", "k8s/d.yaml", join(d, "old.yaml"), "abc", "100644", join(d, "new.yaml"), "def", "100644");
    expect(r.code).toBe(0);
    expect(r.out).toContain("yad k8s/d.yaml — differs");
    expect(r.out).toContain("spec.replicas: 2 → 6");
    const added = run("git-diff", "n.yaml", "/dev/null", ".", ".", join(d, "new.yaml"), "def", "100644");
    expect(added.out).toContain("only on the right");
  });
});

describe("yad-cli merge", () => {
  const files = () => tree({ "base.yaml": dep(2, "  paused: false\n"), "ours.yaml": dep(3, "  paused: false\n"), "theirs.yaml": dep(2, "  paused: true\n"), "conflict.yaml": dep(5, "  paused: false\n") });

  it("merges cleanly into stdout or a file", () => {
    const d = files();
    const r = run("merge", join(d, "base.yaml"), join(d, "ours.yaml"), join(d, "theirs.yaml"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("replicas: 3");
    expect(r.out).toContain("paused: true");
    expect(run("merge", "-o", join(d, "out.yaml"), join(d, "base.yaml"), join(d, "ours.yaml"), join(d, "theirs.yaml")).code).toBe(0);
    expect(readFileSync(join(d, "out.yaml"), "utf8")).toBe(dep(3, "  paused: true\n"));
  });

  it("reports conflicts and writes nothing unless --prefer", () => {
    const d = files();
    const args = [join(d, "base.yaml"), join(d, "ours.yaml"), join(d, "conflict.yaml")];
    const r = run("merge", "-o", join(d, "out.yaml"), ...args);
    expect(r.code).toBe(1);
    expect(r.err).toContain("conflict: Deployment shop/api spec.replicas: base 2, ours 3, theirs 5");
    expect(() => readFileSync(join(d, "out.yaml"))).toThrow();
    expect(run("merge", "--prefer", "theirs", ...args).out).toContain("replicas: 5");
    expect(run("merge", "--prefer=ours", ...args).out).toContain("replicas: 3");
  });

  it("works as a git merge driver, falling back to conflict markers", () => {
    const d = files();
    const clean = run("merge-driver", join(d, "base.yaml"), join(d, "ours.yaml"), join(d, "theirs.yaml"), "k8s/api.yaml", "7");
    expect(clean.code).toBe(0);
    expect(readFileSync(join(d, "ours.yaml"), "utf8")).toBe(dep(3, "  paused: true\n"));

    const d2 = files();
    const bad = run("merge-driver", join(d2, "base.yaml"), join(d2, "ours.yaml"), join(d2, "conflict.yaml"), "k8s/api.yaml");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("yad: k8s/api.yaml: conflict:");
    expect(readFileSync(join(d2, "ours.yaml"), "utf8")).toMatch(/<<<<<<< ours\n {2}replicas: 3\n=======\n {2}replicas: 5\n>>>>>>> theirs/);
  });
});
