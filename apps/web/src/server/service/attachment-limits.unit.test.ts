import { describe, expect, it } from "vitest";

import {
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_TOTAL_ATTACHMENT_BYTES,
  assertAttachmentsWithinLimit,
  base64DecodedBytes,
  derivedMaxAttachmentBytes,
  totalAttachmentBytes,
} from "~/server/service/attachment-limits";

/** `bytes` raw bytes worth of base64, without allocating the buffer twice. */
function base64OfSize(bytes: number): string {
  return Buffer.alloc(bytes, 0x61).toString("base64");
}

describe("attachment limits", () => {
  describe("base64DecodedBytes", () => {
    it("measures without decoding", () => {
      for (const size of [0, 1, 2, 3, 4, 5, 100, 1023, 4096]) {
        expect(base64DecodedBytes(base64OfSize(size))).toBe(size);
      }
    });

    it("accounts for both padding lengths", () => {
      // 1 byte -> "YQ==" (two pads), 2 bytes -> "YWE=" (one pad).
      expect(base64DecodedBytes("YQ==")).toBe(1);
      expect(base64DecodedBytes("YWE=")).toBe(2);
      expect(base64DecodedBytes("YWFh")).toBe(3);
    });
  });

  describe("totalAttachmentBytes", () => {
    it("is zero for nothing to measure", () => {
      expect(totalAttachmentBytes(undefined)).toBe(0);
      expect(totalAttachmentBytes([])).toBe(0);
    });

    it("aggregates across attachments", () => {
      expect(
        totalAttachmentBytes([
          { filename: "a.bin", content: base64OfSize(300) },
          { filename: "b.bin", content: base64OfSize(700) },
        ]),
      ).toBe(1000);
    });
  });

  describe("assertAttachmentsWithinLimit", () => {
    it("allows an email with no attachments", () => {
      expect(() => assertAttachmentsWithinLimit(undefined)).not.toThrow();
      expect(() => assertAttachmentsWithinLimit([])).not.toThrow();
    });

    it("allows an aggregate exactly on the limit", () => {
      expect(() =>
        assertAttachmentsWithinLimit([
          {
            filename: "on-the-line.bin",
            content: base64OfSize(MAX_TOTAL_ATTACHMENT_BYTES),
          },
        ]),
      ).not.toThrow();
    });

    it("rejects one byte over, and names the limit", () => {
      expect(() =>
        assertAttachmentsWithinLimit([
          {
            filename: "too-big.bin",
            content: base64OfSize(MAX_TOTAL_ATTACHMENT_BYTES + 1),
          },
        ]),
      ).toThrow(/25\.0 MB limit for a single email/);
    });

    it("rejects an aggregate that no single attachment exceeds", () => {
      const half = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 2) + 1;

      expect(() =>
        assertAttachmentsWithinLimit([
          { filename: "a.bin", content: base64OfSize(half) },
          { filename: "b.bin", content: base64OfSize(half) },
        ]),
      ).toThrow(/over the/);
    });

    it("still rejects too many attachments, whatever their size", () => {
      const many = Array.from(
        { length: MAX_ATTACHMENTS_PER_EMAIL + 1 },
        (_, i) => ({ filename: `${i}.txt`, content: base64OfSize(1) }),
      );

      expect(() => assertAttachmentsWithinLimit(many)).toThrow(
        /Too many attachments: 11/,
      );
    });

    it("answers with a 400, not a 500 at the SES call", () => {
      try {
        assertAttachmentsWithinLimit([
          {
            filename: "too-big.bin",
            content: base64OfSize(MAX_TOTAL_ATTACHMENT_BYTES + 1),
          },
        ]);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("BAD_REQUEST");
      }
    });
  });

  describe("the derivation behind the number", () => {
    it("leaves the cap under what SES will accept post-base64", () => {
      // The whole point of the cap: 25 MiB of attachment, plus its base64
      // inflation and the 10% reserved for headers and body, has to fit in
      // SES's 40 MB.
      expect(MAX_TOTAL_ATTACHMENT_BYTES).toBeLessThanOrEqual(
        derivedMaxAttachmentBytes(),
      );

      const encoded = MAX_TOTAL_ATTACHMENT_BYTES * (4 / 3) * (78 / 76);
      expect(encoded).toBeLessThan(40_000_000);
    });

    it("is not so conservative that it is arbitrary", () => {
      // Within 10% of the derived ceiling -- if a future edit drops the cap far
      // below what the derivation supports, that is a choice worth restating.
      expect(MAX_TOTAL_ATTACHMENT_BYTES).toBeGreaterThan(
        derivedMaxAttachmentBytes() * 0.9,
      );
    });
  });
});
