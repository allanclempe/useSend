import { z } from "zod";

import { getCanonicalContactVariableName } from "~/lib/contact-properties";

/**
 * What a pasted blob or an uploaded `.csv`/`.txt` means as a list of contacts.
 *
 * Split out of the bulk-upload dialog because it is the only part of that
 * dialog with a right and a wrong answer, and in the Next.js version it ran
 * three times per keystroke from inside the component body. It is also the one
 * piece of the contacts area where a quiet mistake is expensive: a
 * misidentified header column silently writes the wrong property onto every
 * contact in the file.
 *
 * The shape it accepts is the shape this app *exports*, so a book can be
 * round-tripped: `Email, First Name, Last Name, Subscribed` plus one column per
 * contact-book variable. A file with no recognisable header falls back to
 * positional columns in that same order, which is what a hand-written list
 * looks like.
 */

const emailSchema = z.string().email();

/** Header spellings that mean "this column is the address". */
const EMAIL_HEADERS = new Set(["email", "e-mail", "email address"]);
const FIRST_NAME_HEADERS = new Set(["firstname", "first name"]);
const LAST_NAME_HEADERS = new Set(["lastname", "last name"]);

/** The server's own cap, repeated so the button can refuse first. */
export const BULK_CONTACT_LIMIT = 50_000;

/** How many rows the dialog shows before it stops drawing them. */
export const PREVIEW_ROWS = 20;

export type ParsedContact = {
  email: string;
  firstName?: string;
  lastName?: string;
  subscribed?: boolean;
  properties?: Record<string, string>;
  isValid: boolean;
};

/**
 * One CSV line into fields, honouring double quotes.
 *
 * Not a general CSV reader: it does not handle an escaped quote inside a
 * quoted field, because nothing that exports a contact list emits one in an
 * address or a first name. It exists so that `"Doe, Jane"` is one field.
 */
function splitLine(line: string): Array<string> {
  const fields: Array<string> = [];
  let current = "";
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current.trim());
  return fields;
}

function isEmail(value: string | undefined): boolean {
  return Boolean(value) && emailSchema.safeParse(value).success;
}

function asSubscribed(value: string | undefined): boolean | undefined {
  const normalised = value?.toLowerCase();

  if (normalised === "yes" || normalised === "true") {
    return true;
  }

  if (normalised === "no" || normalised === "false") {
    return false;
  }

  return undefined;
}

function parseWithHeaders(
  fields: Array<string>,
  headers: Array<string>,
  bookVariables: Array<string>,
): Omit<ParsedContact, "isValid"> | null {
  const emailIndex = headers.findIndex((header) =>
    EMAIL_HEADERS.has(header.trim().toLowerCase()),
  );
  const email = fields[emailIndex]?.toLowerCase();

  if (!email?.includes("@")) {
    return null;
  }

  let firstName: string | undefined;
  let lastName: string | undefined;
  let subscribed: boolean | undefined;
  const properties: Record<string, string> = {};

  fields.forEach((value, index) => {
    const header = headers[index]?.trim();
    const normalised = header?.toLowerCase();

    if (!header || !normalised || EMAIL_HEADERS.has(normalised)) {
      return;
    }

    if (FIRST_NAME_HEADERS.has(normalised)) {
      firstName = value || undefined;
    } else if (LAST_NAME_HEADERS.has(normalised)) {
      lastName = value || undefined;
    } else if (normalised === "subscribed") {
      subscribed = asSubscribed(value);
    } else if (value) {
      // An unrecognised column is a contact-book variable. Matching it back to
      // the book's own spelling is what stops "First Name" and "firstName"
      // becoming two properties.
      const key =
        getCanonicalContactVariableName(header, bookVariables) ?? header;
      properties[key] = value;
    }
  });

  return {
    email,
    firstName,
    lastName,
    subscribed,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
  };
}

function parsePositionally(
  fields: Array<string>,
): Omit<ParsedContact, "isValid"> | null {
  const email = fields[0]?.toLowerCase();

  if (!email?.includes("@")) {
    return null;
  }

  return {
    email,
    firstName: fields[1] || undefined,
    lastName: fields[2] || undefined,
    subscribed: asSubscribed(fields[3]),
  };
}

export function parseContacts(
  text: string,
  bookVariables: Array<string> = [],
): Array<ParsedContact> {
  const lines = text.split("\n");
  const firstLine = lines[0]
    ?.split(",")
    .map((field) => field.trim().replace(/^"|"$/g, ""));

  // A first row is a header row only if it *names* an email column and does
  // not *contain* an address. A file whose first data row happens to start
  // with the word "email" would otherwise lose its first contact.
  const hasHeaders =
    Boolean(firstLine?.some((f) => EMAIL_HEADERS.has(f.toLowerCase()))) &&
    !firstLine?.some((f) => isEmail(f));
  const headers = hasHeaders ? firstLine : undefined;

  // Keyed by address, so the first occurrence of a duplicate wins.
  const byEmail = new Map<string, ParsedContact>();

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const fields = splitLine(line);

    if (!fields[0]) {
      continue;
    }

    // A positional file's own header row, if it has one, is skipped here.
    if (!headers && EMAIL_HEADERS.has(fields[0].toLowerCase())) {
      continue;
    }

    const parsed = headers
      ? parseWithHeaders(fields, headers, bookVariables)
      : parsePositionally(fields);

    if (parsed && !byEmail.has(parsed.email)) {
      byEmail.set(parsed.email, { ...parsed, isValid: isEmail(parsed.email) });
    }
  }

  return Array.from(byEmail.values());
}
