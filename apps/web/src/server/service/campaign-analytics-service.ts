import { eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { drizzleDb, schema } from "../drizzle";
import { withUpdatedAt } from "../drizzle/touch";
import { EmailStatus } from "~/types/db";

/**
 * The campaign counters, split out of `campaign-service` so they can be reached
 * without it.
 *
 * `email-queue-service` now bumps `Campaign.sent` itself, at the SES handoff,
 * because the SES `Send` notification that used to do it is no longer
 * subscribed. Importing `campaign-service` from there would close a cycle —
 * `campaign-service` enqueues through `email-queue-service` — and this file has
 * no dependencies beyond the schema, so it is the natural thing to lift out.
 *
 * `campaign-service` re-exports it, so existing callers are unaffected.
 */
export async function updateCampaignAnalytics(
  campaignId: string,
  emailStatus: EmailStatus,
  hardBounce: boolean = false,
) {
  const [campaign] = await drizzleDb
    .select({ id: schema.campaign.id })
    .from(schema.campaign)
    .where(eq(schema.campaign.id, campaignId))
    .limit(1);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  // Every counter is incremented in SQL. These run once per inbound SES event,
  // so several can land on the same campaign at once and a read-then-write
  // would drop them.
  const bump = (column: AnyPgColumn) => sql`${column} + 1`;

  const updateData: Record<string, unknown> = {};

  switch (emailStatus) {
    case EmailStatus.SENT:
      updateData.sent = bump(schema.campaign.sent);
      break;
    case EmailStatus.DELIVERED:
      updateData.delivered = bump(schema.campaign.delivered);
      break;
    case EmailStatus.OPENED:
      updateData.opened = bump(schema.campaign.opened);
      break;
    case EmailStatus.CLICKED:
      updateData.clicked = bump(schema.campaign.clicked);
      break;
    case EmailStatus.BOUNCED:
      updateData.bounced = bump(schema.campaign.bounced);
      if (hardBounce) {
        updateData.hardBounced = bump(schema.campaign.hardBounced);
      }
      break;
    case EmailStatus.COMPLAINED:
      updateData.complained = bump(schema.campaign.complained);
      break;
    default:
      break;
  }

  // Prisma accepted an empty update as a no-op; an empty SET is invalid SQL.
  if (Object.keys(updateData).length === 0) {
    return;
  }

  await drizzleDb
    .update(schema.campaign)
    .set(withUpdatedAt(updateData))
    .where(eq(schema.campaign.id, campaignId));
}
