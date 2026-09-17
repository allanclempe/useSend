import { describe, expect, it } from "vitest";

import { maskEmail } from "./redact";

describe("maskEmail", () => {
  it("keeps a two-character prefix and the whole domain", () => {
    expect(maskEmail("alice@example.com")).toBe("al***@example.com");
  });

  it("does not leak a short local part", () => {
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("splits on the last @, not the first", () => {
    expect(maskEmail('"weird@local"@example.com')).toBe('"w***@example.com');
  });

  it("gives up rather than guessing on a non-address", () => {
    expect(maskEmail("not-an-address")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
  });

  it("passes through nothing when there is nothing", () => {
    expect(maskEmail(undefined)).toBeUndefined();
    expect(maskEmail(null)).toBeUndefined();
    expect(maskEmail("")).toBeUndefined();
  });
});
