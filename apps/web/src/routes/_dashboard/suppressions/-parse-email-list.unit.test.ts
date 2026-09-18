import { describe, expect, it } from "vitest";

import { parseEmailList } from "./-parse-email-list";

describe("parseEmailList", () => {
  it("splits on newlines, commas and semicolons", () => {
    const { valid } = parseEmailList("a@b.com\nc@d.com, e@f.com; g@h.com");

    expect(valid).toEqual(["a@b.com", "c@d.com", "e@f.com", "g@h.com"]);
  });

  it("trims, lowercases and de-duplicates", () => {
    const { found } = parseEmailList("  A@B.com \n a@b.com\n\n,,");

    expect(found).toEqual(["a@b.com"]);
  });

  it("reports malformed entries as found but not valid", () => {
    const { found, valid } = parseEmailList("good@example.com\nnot-an-email");

    expect(found).toHaveLength(2);
    expect(valid).toEqual(["good@example.com"]);
  });

  it("is empty for empty input rather than one empty entry", () => {
    expect(parseEmailList("   \n\n")).toEqual({ found: [], valid: [] });
  });
});
