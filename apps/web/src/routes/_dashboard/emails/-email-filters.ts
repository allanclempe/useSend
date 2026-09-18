import { z } from "zod";

import type { EmailListFilters } from "~/queries/email";
import { EmailStatus } from "~/types/db";

/**
 * The shape of `/emails`'s URL.
 *
 * Every filter the log has lives here rather than in `useState`, so a link to a
 * filtered page is a link to a filtered page. The names are the ones people
 * already have bookmarked — `apikey`, not `apiId` — and they are the names the
 * Next.js page wrote through `useUrlState`.
 *
 * Nothing in here throws. These values arrive from a URL bar, and a typo in
 * `?status=` should show the unfiltered log rather than an error page, so every
 * field falls back to "not set" when it cannot be parsed.
 */

const statuses = Object.values(EmailStatus) as [EmailStatus, ...EmailStatus[]];

export const emailSearchSchema = z.object({
  page: z.coerce.number().int().positive().catch(1),
  status: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(statuses))
    .optional()
    .catch(undefined),
  search: z.string().optional().catch(undefined),
  domain: z.coerce.number().int().positive().optional().catch(undefined),
  apikey: z.coerce.number().int().positive().optional().catch(undefined),
  emailId: z.string().optional().catch(undefined),
});

export type EmailSearch = z.infer<typeof emailSearchSchema>;

/**
 * The list query's filters are the search params minus the sheet. Derived in
 * one place because the route loader and the table both key the cache with it,
 * and two call sites building the object by hand would eventually disagree.
 */
export function emailListFilters(search: EmailSearch): EmailListFilters {
  return {
    page: search.page,
    status: search.status,
    domain: search.domain,
    search: search.search,
    apiId: search.apikey,
  };
}

/**
 * The statuses the dropdown offers. Deliberately not every `EmailStatus`: the
 * four it leaves out (`CANCELLED`, `REJECTED`, `FAILED`, `RENDERING_FAILURE`)
 * are rare enough that they were never worth a row in the menu. A URL naming
 * one still filters by it — the schema above accepts the whole enum.
 */
export const FILTERABLE_STATUSES: Array<EmailStatus> = [
  EmailStatus.SENT,
  EmailStatus.SCHEDULED,
  EmailStatus.QUEUED,
  EmailStatus.DELIVERED,
  EmailStatus.BOUNCED,
  EmailStatus.CLICKED,
  EmailStatus.OPENED,
  EmailStatus.DELIVERY_DELAYED,
  EmailStatus.COMPLAINED,
  EmailStatus.SUPPRESSED,
];
