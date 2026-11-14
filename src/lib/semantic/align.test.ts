import { describe, expect, it } from "vitest";
import { alignOrder } from "./index";

describe("alignOrder", () => {
  it("moves a section to where the other file has it, with its comments", () => {
    const stage = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      "  replicas: 2",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          image: api:1",
      "          # limits for stage",
      "          resources:",
      "            limits: {cpu: 1}",
      "",
    ].join("\n");
    const prod = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          # limits for prod",
      "          resources:",
      "            limits: {cpu: 2}",
      "          image: api:2",
      "  replicas: 6",
      "",
    ].join("\n");
    const r = alignOrder(prod, stage);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe(stage.replace("api:1", "api:2").replace("replicas: 2", "replicas: 6").replace("stage", "prod").replace("cpu: 1", "cpu: 2"));
  });

  it("reorders documents and keyed list items, and the first key of a list item", () => {
    const a = "apiVersion: v1\nkind: Service\nmetadata: {name: s}\n---\napiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  containers:\n    - name: a\n      image: x\n    - name: b\n      image: y\n";
    const b = "apiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  containers:\n    - image: y\n      name: b\n    - image: x\n      name: a\n---\napiVersion: v1\nkind: Service\nmetadata: {name: s}\n";
    const r = alignOrder(b, a);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe(a);
  });

  it("never reorders pipeline steps, but does reorder keys", () => {
    const a = "on: [push]\nname: CI\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: one\n      - run: two\n";
    const b = "name: CI\non: [push]\njobs:\n  build:\n    steps:\n      - run: two\n      - run: one\n    runs-on: x\n";
    const r = alignOrder(b, a);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("on: [push]\nname: CI\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: two\n      - run: one\n");
  });

  it("does nothing when the order already matches", () => {
    const a = "a: 1\nb: 2\n";
    expect(alignOrder(a, "a: 5\nb: 6\n")).toEqual({ text: a, moved: 0 });
  });
});
