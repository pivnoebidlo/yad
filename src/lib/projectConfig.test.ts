import { describe, expect, it } from "vitest";
import { applyProjectCompare, applyProjectFormat, parseProjectConfig } from "./projectConfig";
import { DEFAULT_IGNORE, defaultFormatOptions, defaultOptions } from "./semantic";

describe(".yad.yaml", () => {
  it("parses settings and reports mistakes without dropping the valid parts", () => {
    const { config, errors } = parseProjectConfig(
      "ignore:\n  - metadata.labels.team\n  - 'a..b'\ncrossNamespace: false\nformat:\n  indent: 4\n  indentLists: false\n  expandNestedJson: false\n  colour: red\nbogus: 1\ndecodeSecrets: maybe\n",
    );
    expect(config.ignore).toEqual([["metadata", "labels", "team"]]);
    expect(config.crossNamespace).toBe(false);
    expect(config.format).toEqual({ indent: 4, indentSeq: false, expandNestedJson: false });
    expect(errors).toEqual([
      'ignore: invalid path "a..b"',
      "format.colour: unknown setting",
      "bogus: unknown setting",
      "decodeSecrets: expected true or false",
    ]);
    expect(parseProjectConfig("").errors).toEqual([]);
    expect(parseProjectConfig("- a\n").errors).toEqual(["expected a map of settings"]);
    expect(parseProjectConfig("a: [1\n").errors).toHaveLength(1);
  });

  it("overrides personal options only where it says something", () => {
    const base = { ...defaultOptions(), ignore: [["spec", "replicas"], ...DEFAULT_IGNORE], emptyEqualsMissing: false };
    const o = applyProjectCompare(base, { ignore: [["metadata", "labels", "team"], ["spec", "replicas"]], crossNamespace: false });
    expect(o.ignore).toEqual([...base.ignore, ["metadata", "labels", "team"]]);
    expect(o.crossNamespace).toBe(false);
    expect(o.emptyEqualsMissing).toBe(false);
    expect(applyProjectCompare(base, { defaultIgnore: false }).ignore).toEqual([["spec", "replicas"]]);
    expect(applyProjectCompare({ ...base, ignore: [] }, { defaultIgnore: true }).ignore).toEqual(DEFAULT_IGNORE);
    expect(applyProjectCompare(base, null)).toBe(base);
    expect(applyProjectFormat(defaultFormatOptions(), { format: { indent: 4 } })).toEqual({ ...defaultFormatOptions(), indent: 4 });
  });
});
