import { describe, expect, it } from "vitest";
import { applyEdits, compareTexts, decodeBase64Text, defaultOptions, encodeBase64Text, planSemanticEdit, presentSecrets, renderNormalized } from "./index";

const b64 = encodeBase64Text;
const secret = (pw: string, extra = "") =>
  `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\ntype: Opaque\ndata:\n  password: ${b64(pw)} # rotated monthly\n  user: ${b64("admin")}\n${extra}`;

describe("Secret values", () => {
  it("decodes only text that encodes back to the same base64", () => {
    expect(decodeBase64Text("aHVudGVyMg==")).toBe("hunter2");
    expect(decodeBase64Text(b64("пароль ✓"))).toBe("пароль ✓");
    expect(decodeBase64Text("AAEC/w==")).toBeUndefined(); // binary
    expect(decodeBase64Text("aHVudGVyMg")).toBeUndefined(); // not padded
    expect(decodeBase64Text("not base64!")).toBeUndefined();
    expect(decodeBase64Text(42)).toBeUndefined();
  });

  it("shows decoded data in the normalized view, keeping binary values as base64", () => {
    const a = secret("old", "  key.bin: AAEC/w==\n");
    const res = compareTexts(a, secret("new", "  key.bin: AAEC/w==\n"));
    const view = renderNormalized(res.resources, defaultOptions());
    expect(view.a).toContain("password: old");
    expect(view.b).toContain("password: new");
    expect(view.a).toContain("key.bin: AAEC/w==");
    expect(view.a).toContain("decoded from base64");
    expect(view.a).not.toContain(b64("old"));
    const off = renderNormalized(res.resources, { ...defaultOptions(), decodeSecrets: false });
    expect(off.a).toContain(`password: ${b64("old")}`);
  });

  it("encodes edits made in the normalized view back to base64 in the file", () => {
    const src = secret("old", "  key.bin: AAEC/w==\n");
    const res = compareTexts(src, src);
    const view = renderNormalized(res.resources, defaultOptions());
    const edited = view.a.replace("password: old", "password: s3cret").replace("user: admin", "user: admin\n  token: abc");
    const plan = planSemanticEdit(view.encode("a", view.a), view.encode("a", edited), src);
    expect(plan.errors).toEqual([]);
    const out = applyEdits(src, plan.edits);
    expect(out).toContain(`password: ${b64("s3cret")} # rotated monthly`);
    expect(out).toContain(`token: ${b64("abc")}`);
    expect(out).toContain("key.bin: AAEC/w==");
    expect(out).not.toContain("s3cret");
  });

  it("hides or decodes values in reports", () => {
    const res = compareTexts(secret("old"), secret("new")).resources;
    expect(res[0].changes[0].a).toBe(b64("old"));
    expect(presentSecrets(res, "hide")[0].changes.map((c) => [c.a, c.b])).toEqual([["(hidden)", "(hidden)"]]);
    expect(presentSecrets(res, "decode")[0].changes.map((c) => [c.a, c.b])).toEqual([["old", "new"]]);
    expect(res[0].changes[0].a).toBe(b64("old")); // the original results are untouched
  });
});
