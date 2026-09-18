import { z } from "zod";

/**
 * What a pasted blob or an uploaded `.txt`/`.csv` means as a list of addresses.
 *
 * Split out of the bulk-add dialog because it is the only part of that dialog
 * with a right and a wrong answer, and it ran on every keystroke inside the
 * component body in the Next.js version. The rules — split on newlines, commas
 * and semicolons, trim, lowercase, de-duplicate — are the ones people's
 * exported lists actually arrive in.
 *
 * Validity is `z.string().email()`, the same rule `bulkAddSuppressions`
 * enforces server-side, so the count shown to the user and the count the
 * server accepts cannot disagree.
 */

const emailSchema = z.string().email();

export type ParsedEmailList = {
  /** Every non-empty, de-duplicated entry found. */
  found: Array<string>;
  /** The subset of `found` that is a well-formed address. */
  valid: Array<string>;
};

/** The server's own cap, repeated here so the button can say so first. */
export const BULK_SUPPRESSION_LIMIT = 1000;

export function parseEmailList(text: string): ParsedEmailList {
  const found = Array.from(
    new Set(
      text
        .split(/[\n,;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  );

  return {
    found,
    valid: found.filter((entry) => emailSchema.safeParse(entry).success),
  };
}
