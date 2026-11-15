import { describe, expect, it } from "vitest";
import { lineDiff, summarizeTextChange } from "./textdiff";

describe("line diff of embedded text", () => {
  const a = "server:\n  host: 0.0.0.0\n  timeout: 30s\n  workers: 4\nlog: info\n";
  const b = "server:\n  host: 0.0.0.0\n  timeout: 60s\n  workers: 4\n  tls: true\nlog: info\n";
  it("lists only the changed lines with their numbers", () => {
    expect(lineDiff(a, b)).toEqual([
      { op: "-", line: 3, text: "  timeout: 30s" },
      { op: "+", line: 3, text: "  timeout: 60s" },
      { op: "+", line: 5, text: "  tls: true" },
    ]);
    expect(lineDiff(a, a)).toEqual([]);
  });
  it("summarizes the first change", () => {
    expect(summarizeTextChange(a, b)).toBe("line 3: timeout: 30s → timeout: 60s (+1 more)");
    expect(summarizeTextChange("a\nb\n", "a\n")).toBe("line 2: removed b");
  });
});
