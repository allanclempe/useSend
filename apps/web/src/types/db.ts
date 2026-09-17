/**
 * Application-facing names for the database schema.
 *
 * This module replaces the types and enums that used to come from
 * `@prisma/client` (issue #5). It is the single seam between the Drizzle schema
 * and the rest of the app, so call sites read `Campaign` / `EmailStatus.SENT`
 * rather than `typeof campaign.$inferSelect` / `"SENT"`.
 *
 * Client components import from here too, so this file must stay client-safe:
 * the schema is pulled in with `import type`, which TypeScript erases entirely.
 * Never add a value import from `~/server/drizzle/schema` — that would drag
 * `drizzle-orm/pg-core` and all 24 table definitions into the browser bundle.
 *
 * The enum objects below are hand-written because they are needed at runtime.
 * Each one is checked against the schema's `pgEnum` with
 * `satisfies Record<T, T>`, so adding or removing a value in the schema without
 * updating it here is a compile error rather than a silent drift.
 */
/* eslint-disable no-redeclare -- Each enum below is deliberately declared
   twice, as a type and as a const, so that `EmailStatus` works in both
   positions exactly as the Prisma-generated enum did. This is standard
   TypeScript declaration merging; the base ESLint rule predates it and
   cannot tell the two declaration spaces apart. */
import type * as schema from "~/server/drizzle/schema";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export type ApiPermission = (typeof schema.apiPermission.enumValues)[number];
export const ApiPermission = {
  FULL: "FULL",
  SENDING: "SENDING",
} as const satisfies Record<ApiPermission, ApiPermission>;

export type CampaignStatus = (typeof schema.campaignStatus.enumValues)[number];
export const CampaignStatus = {
  DRAFT: "DRAFT",
  SCHEDULED: "SCHEDULED",
  SENT: "SENT",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
} as const satisfies Record<CampaignStatus, CampaignStatus>;

export type DomainStatus = (typeof schema.domainStatus.enumValues)[number];
export const DomainStatus = {
  NOT_STARTED: "NOT_STARTED",
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  TEMPORARY_FAILURE: "TEMPORARY_FAILURE",
} as const satisfies Record<DomainStatus, DomainStatus>;

export type EmailStatus = (typeof schema.emailStatus.enumValues)[number];
export const EmailStatus = {
  SCHEDULED: "SCHEDULED",
  CANCELLED: "CANCELLED",
  RENDERING_FAILURE: "RENDERING_FAILURE",
  QUEUED: "QUEUED",
  SENT: "SENT",
  REJECTED: "REJECTED",
  DELIVERY_DELAYED: "DELIVERY_DELAYED",
  DELIVERED: "DELIVERED",
  BOUNCED: "BOUNCED",
  OPENED: "OPENED",
  CLICKED: "CLICKED",
  COMPLAINED: "COMPLAINED",
  FAILED: "FAILED",
  SUPPRESSED: "SUPPRESSED",
} as const satisfies Record<EmailStatus, EmailStatus>;

export type EmailUsageType = (typeof schema.emailUsageType.enumValues)[number];
export const EmailUsageType = {
  TRANSACTIONAL: "TRANSACTIONAL",
  MARKETING: "MARKETING",
} as const satisfies Record<EmailUsageType, EmailUsageType>;

export type Plan = (typeof schema.plan.enumValues)[number];
export const Plan = {
  FREE: "FREE",
  BASIC: "BASIC",
} as const satisfies Record<Plan, Plan>;

export type Role = (typeof schema.role.enumValues)[number];
export const Role = {
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
} as const satisfies Record<Role, Role>;

export type SuppressionReason =
  (typeof schema.suppressionReason.enumValues)[number];
export const SuppressionReason = {
  HARD_BOUNCE: "HARD_BOUNCE",
  COMPLAINT: "COMPLAINT",
  MANUAL: "MANUAL",
} as const satisfies Record<SuppressionReason, SuppressionReason>;

export type UnsubscribeReason =
  (typeof schema.unsubscribeReason.enumValues)[number];
export const UnsubscribeReason = {
  BOUNCED: "BOUNCED",
  COMPLAINED: "COMPLAINED",
  UNSUBSCRIBED: "UNSUBSCRIBED",
} as const satisfies Record<UnsubscribeReason, UnsubscribeReason>;

export type WebhookCallStatus =
  (typeof schema.webhookCallStatus.enumValues)[number];
export const WebhookCallStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  DELIVERED: "DELIVERED",
  FAILED: "FAILED",
  DISCARDED: "DISCARDED",
} as const satisfies Record<WebhookCallStatus, WebhookCallStatus>;

export type WebhookStatus = (typeof schema.webhookStatus.enumValues)[number];
export const WebhookStatus = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  AUTO_DISABLED: "AUTO_DISABLED",
} as const satisfies Record<WebhookStatus, WebhookStatus>;

/* -------------------------------------------------------------------------- */
/* Row types                                                                   */
/* -------------------------------------------------------------------------- */

export type ApiKey = typeof schema.apiKey.$inferSelect;
export type Campaign = typeof schema.campaign.$inferSelect;
export type Contact = typeof schema.contact.$inferSelect;
export type ContactBook = typeof schema.contactBook.$inferSelect;
export type DailyEmailUsage = typeof schema.dailyEmailUsage.$inferSelect;
export type Domain = typeof schema.domain.$inferSelect;
export type Email = typeof schema.email.$inferSelect;
export type SesSetting = typeof schema.sesSetting.$inferSelect;
export type Subscription = typeof schema.subscription.$inferSelect;
export type SuppressionList = typeof schema.suppressionList.$inferSelect;
export type Team = typeof schema.team.$inferSelect;
export type Template = typeof schema.template.$inferSelect;
export type Webhook = typeof schema.webhook.$inferSelect;

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Stands in for `Prisma.JsonValue`.
 *
 * Drizzle types a `jsonb` column as `unknown`, which is correct but unusable at
 * the call sites that render this data. The few places that read jsonb narrow
 * to this type with a cast, exactly as they did when Prisma supplied it.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
