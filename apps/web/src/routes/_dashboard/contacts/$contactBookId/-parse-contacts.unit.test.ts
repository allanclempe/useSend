import { describe, expect, it } from "vitest";

import { parseContacts } from "./-parse-contacts";

describe("parseContacts", () => {
  describe("without a header row", () => {
    it("reads email, first name, last name and subscribed positionally", () => {
      const [contact] = parseContacts("john@example.com,John,Doe,Yes");

      expect(contact).toMatchObject({
        email: "john@example.com",
        firstName: "John",
        lastName: "Doe",
        subscribed: true,
        isValid: true,
      });
    });

    it("leaves subscribed undefined when the column is absent", () => {
      const [contact] = parseContacts("solo@example.com");

      expect(contact?.subscribed).toBeUndefined();
    });

    it("skips a bare email header line", () => {
      expect(parseContacts("Email\njohn@example.com")).toHaveLength(1);
    });
  });

  describe("with a header row", () => {
    it("finds the address wherever its column is", () => {
      const [contact] = parseContacts(
        "First Name,Email,Last Name\nJohn,john@example.com,Doe",
      );

      expect(contact).toMatchObject({
        email: "john@example.com",
        firstName: "John",
        lastName: "Doe",
      });
    });

    it("reads unrecognised columns as contact properties", () => {
      const [contact] = parseContacts(
        "Email,Company\njohn@example.com,Acme Inc",
        ["Company"],
      );

      expect(contact?.properties).toEqual({ Company: "Acme Inc" });
    });

    it("matches a property back to the book's own spelling", () => {
      const [contact] = parseContacts("Email,company\njohn@example.com,Acme", [
        "Company",
      ]);

      expect(contact?.properties).toEqual({ Company: "Acme" });
    });

    it("omits properties entirely when there are none", () => {
      const [contact] = parseContacts("Email\njohn@example.com");

      expect(contact?.properties).toBeUndefined();
    });

    it("does not treat a data row as headers just because it says email", () => {
      // "email@example.com" contains "email" but is an address, so this file
      // has no header row and its first line is a contact.
      expect(parseContacts("email@example.com,First")).toHaveLength(1);
    });
  });

  it("honours quotes so a comma can sit inside a field", () => {
    const [contact] = parseContacts(
      'Email,Last Name\njohn@example.com,"Doe, Jr."',
    );

    expect(contact?.lastName).toBe("Doe, Jr.");
  });

  it("de-duplicates on the address, first occurrence winning", () => {
    const contacts = parseContacts(
      "john@example.com,First\njohn@example.com,Second",
    );

    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.firstName).toBe("First");
  });

  it("keeps a malformed address in the list but marks it invalid", () => {
    const contacts = parseContacts("good@example.com\nnot-an-email@\n");

    expect(contacts.map((c) => c.isValid)).toEqual([true, false]);
  });

  it("ignores blank lines", () => {
    expect(parseContacts("\n\njohn@example.com\n\n")).toHaveLength(1);
  });
});
