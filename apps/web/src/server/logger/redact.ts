/**
 * A log attribute is structured, indexed and retained. An email address in one
 * is personal data sitting in a telemetry backend with a different retention
 * policy and a different access list from the database it came from.
 *
 * `maskEmail` keeps what debugging actually needs — a recognisable prefix and
 * the full domain, which is what deliverability questions turn on — and drops
 * the rest. It is not reversible and is not meant to be: the row id logged next
 * to it is how you find the record.
 */
export function maskEmail(
  email: string | null | undefined,
): string | undefined {
  if (!email) {
    return undefined;
  }

  const at = email.lastIndexOf("@");
  if (at <= 0) {
    // Not an address we recognise; do not guess at which half is sensitive.
    return "***";
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);

  return `${visible}***@${domain}`;
}
