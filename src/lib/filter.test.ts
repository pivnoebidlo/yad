import { describe, expect, it } from "vitest";
import { matcher } from "./filter";

describe("list filter", () => {
  it("matches every word, case-insensitively, anywhere", () => {
    expect(matcher("  ")).toBeNull();
    const m = matcher("prod Deploy")!;
    expect(m("k8s/prod/deployment.yaml")).toBe(true);
    expect(m("k8s/stage/deployment.yaml")).toBe(false);
    expect(matcher("replicas 6")!("Deployment shop/api spec.replicas 2 → 6")).toBe(true);
  });
});
