// The database schema, and the source of truth for it.
//
// Hand-authored. This was introspected from the Prisma-managed database while
// the two ORMs ran side by side, which is why it still reads like generated
// code — but Prisma is gone and there is nothing left to introspect from.
// Edit this file, then `pnpm --filter=web db:generate` to write the migration.
//
// Indexes carry no explicit operator class. drizzle-kit pull emitted a `.op()`
// on every indexed column, naming the default class for the column type — but
// it got several wrong (a `timestamp_ops` on an enum, an `int4_ops` on text),
// which Postgres rejects outright at CREATE INDEX. They were redundant even
// where correct, since the database they were read from used the defaults.
//
// Timestamps are deliberately `mode: 'date'`, not drizzle-kit's default
// `mode: 'string'`: the codebase does date arithmetic on scheduledAt,
// lastSentAt and createdAt cutoffs all over.

import { pgTable, timestamp, text, integer, index, serial, uniqueIndex, foreignKey, boolean, jsonb, primaryKey, bigint, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const apiPermission = pgEnum("ApiPermission", ['FULL', 'SENDING'])
export const campaignStatus = pgEnum("CampaignStatus", ['DRAFT', 'SCHEDULED', 'SENT', 'RUNNING', 'PAUSED'])
export const domainStatus = pgEnum("DomainStatus", ['NOT_STARTED', 'PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE'])
export const emailStatus = pgEnum("EmailStatus", ['SCHEDULED', 'CANCELLED', 'RENDERING_FAILURE', 'QUEUED', 'SENT', 'REJECTED', 'DELIVERY_DELAYED', 'DELIVERED', 'BOUNCED', 'OPENED', 'CLICKED', 'COMPLAINED', 'FAILED', 'SUPPRESSED'])
export const emailUsageType = pgEnum("EmailUsageType", ['TRANSACTIONAL', 'MARKETING'])
export const plan = pgEnum("Plan", ['FREE', 'BASIC'])
export const role = pgEnum("Role", ['ADMIN', 'MEMBER'])
export const suppressionReason = pgEnum("SuppressionReason", ['HARD_BOUNCE', 'COMPLAINT', 'MANUAL'])
export const unsubscribeReason = pgEnum("UnsubscribeReason", ['BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED'])
export const webhookCallStatus = pgEnum("WebhookCallStatus", ['PENDING', 'IN_PROGRESS', 'DELIVERED', 'FAILED', 'DISCARDED'])
export const webhookStatus = pgEnum("WebhookStatus", ['ACTIVE', 'PAUSED', 'AUTO_DISABLED'])


export const verification = pgTable("Verification", {
	id: serial().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("Verification_identifier_idx").using("btree", table.identifier.asc().nullsLast()),
]);

export const account = pgTable("Account", {
	id: serial().primaryKey().notNull(),
	accountId: text().notNull(),
	providerId: text().notNull(),
	userId: integer().notNull(),
	accessToken: text(),
	refreshToken: text(),
	idToken: text(),
	accessTokenExpiresAt: timestamp({ precision: 3, mode: 'date' }),
	refreshTokenExpiresAt: timestamp({ precision: 3, mode: 'date' }),
	scope: text(),
	password: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("Account_providerId_accountId_key").using("btree", table.providerId.asc().nullsLast(), table.accountId.asc().nullsLast()),
	index("Account_userId_idx").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "Account_userId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const session = pgTable("Session", {
	id: serial().primaryKey().notNull(),
	token: text().notNull(),
	userId: integer().notNull(),
	expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	ipAddress: text(),
	userAgent: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("Session_token_key").using("btree", table.token.asc().nullsLast()),
	index("Session_userId_idx").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "Session_userId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const teamUser = pgTable("TeamUser", {
	teamId: integer().notNull(),
	userId: integer().notNull(),
	role: role().notNull(),
}, (table) => [
	uniqueIndex("TeamUser_teamId_userId_key").using("btree", table.teamId.asc().nullsLast(), table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "TeamUser_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "TeamUser_userId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const suppressionList = pgTable("SuppressionList", {
	id: text().primaryKey().notNull(),
	email: text().notNull(),
	teamId: integer().notNull(),
	reason: suppressionReason().notNull(),
	source: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	uniqueIndex("SuppressionList_teamId_email_key").using("btree", table.teamId.asc().nullsLast(), table.email.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "SuppressionList_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const subscription = pgTable("Subscription", {
	id: text().primaryKey().notNull(),
	teamId: integer().notNull(),
	status: text().notNull(),
	priceId: text().notNull(),
	currentPeriodEnd: timestamp({ precision: 3, mode: 'date' }),
	currentPeriodStart: timestamp({ precision: 3, mode: 'date' }),
	cancelAtPeriodEnd: timestamp({ precision: 3, mode: 'date' }),
	paymentMethod: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	priceIds: text().array().default([]).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Subscription_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const campaign = pgTable("Campaign", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	teamId: integer().notNull(),
	from: text().notNull(),
	cc: text().array().default([]).notNull(),
	bcc: text().array().default([]).notNull(),
	replyTo: text().array().default([]).notNull(),
	domainId: integer().notNull(),
	subject: text().notNull(),
	previewText: text(),
	html: text(),
	content: text(),
	contactBookId: text(),
	total: integer().default(0).notNull(),
	sent: integer().default(0).notNull(),
	delivered: integer().default(0).notNull(),
	opened: integer().default(0).notNull(),
	clicked: integer().default(0).notNull(),
	unsubscribed: integer().default(0).notNull(),
	bounced: integer().default(0).notNull(),
	complained: integer().default(0).notNull(),
	status: campaignStatus().default('DRAFT').notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	hardBounced: integer().default(0).notNull(),
	batchSize: integer().default(500).notNull(),
	batchWindowMinutes: integer().default(0).notNull(),
	lastCursor: text(),
	lastSentAt: timestamp({ precision: 3, mode: 'date' }),
	scheduledAt: timestamp({ precision: 3, mode: 'date' }),
	isApi: boolean().default(false).notNull(),
}, (table) => [
	index("Campaign_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst()),
	index("Campaign_status_scheduledAt_idx").using("btree", table.status.asc().nullsLast(), table.scheduledAt.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Campaign_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const domain = pgTable("Domain", {
	id: serial().primaryKey().notNull(),
	name: text().notNull(),
	teamId: integer().notNull(),
	status: domainStatus().default('PENDING').notNull(),
	region: text().default('us-east-1').notNull(),
	clickTracking: boolean().default(false).notNull(),
	openTracking: boolean().default(false).notNull(),
	publicKey: text().notNull(),
	dkimStatus: text(),
	spfDetails: text(),
	dmarcAdded: boolean().default(false).notNull(),
	errorMessage: text(),
	subdomain: text(),
	isVerifying: boolean().default(false).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	sesTenantId: text(),
	dkimSelector: text().default('usesend'),
}, (table) => [
	uniqueIndex("Domain_name_key").using("btree", table.name.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Domain_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const sesSetting = pgTable("SesSetting", {
	id: text().primaryKey().notNull(),
	region: text().notNull(),
	idPrefix: text().notNull(),
	topic: text().notNull(),
	topicArn: text(),
	callbackUrl: text().notNull(),
	callbackSuccess: boolean().default(false).notNull(),
	configGeneral: text(),
	configGeneralSuccess: boolean().default(false).notNull(),
	configClick: text(),
	configClickSuccess: boolean().default(false).notNull(),
	configOpen: text(),
	configOpenSuccess: boolean().default(false).notNull(),
	configFull: text(),
	configFullSuccess: boolean().default(false).notNull(),
	sesEmailRateLimit: integer().default(1).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	transactionalQuota: integer().default(50).notNull(),
}, (table) => [
	uniqueIndex("SesSetting_idPrefix_key").using("btree", table.idPrefix.asc().nullsLast()),
	uniqueIndex("SesSetting_region_key").using("btree", table.region.asc().nullsLast()),
]);

export const webhookCall = pgTable("WebhookCall", {
	id: text().primaryKey().notNull(),
	webhookId: text().notNull(),
	teamId: integer().notNull(),
	type: text().notNull(),
	payload: text().notNull(),
	status: webhookCallStatus().default('PENDING').notNull(),
	attempt: integer().default(0).notNull(),
	nextAttemptAt: timestamp({ precision: 3, mode: 'date' }),
	lastError: text(),
	responseStatus: integer(),
	responseTimeMs: integer(),
	responseText: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	index("WebhookCall_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst()),
	index("WebhookCall_teamId_webhookId_status_idx").using("btree", table.teamId.asc().nullsLast(), table.webhookId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.webhookId],
			foreignColumns: [webhook.id],
			name: "WebhookCall_webhookId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "WebhookCall_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const contact = pgTable("Contact", {
	id: text().primaryKey().notNull(),
	firstName: text(),
	lastName: text(),
	email: text().notNull(),
	subscribed: boolean().default(true).notNull(),
	properties: jsonb().notNull(),
	contactBookId: text().notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	unsubscribeReason: unsubscribeReason(),
}, (table) => [
	uniqueIndex("Contact_contactBookId_email_key").using("btree", table.contactBookId.asc().nullsLast(), table.email.asc().nullsLast()),
	index("Contact_contactBookId_id_idx").using("btree", table.contactBookId.asc().nullsLast(), table.id.asc().nullsLast()),
	foreignKey({
			columns: [table.contactBookId],
			foreignColumns: [contactBook.id],
			name: "Contact_contactBookId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const webhook = pgTable("Webhook", {
	id: text().primaryKey().notNull(),
	teamId: integer().notNull(),
	url: text().notNull(),
	description: text(),
	secret: text().notNull(),
	status: webhookStatus().default('ACTIVE').notNull(),
	eventTypes: text().array().default([]).notNull(),
	apiVersion: text(),
	consecutiveFailures: integer().default(0).notNull(),
	lastFailureAt: timestamp({ precision: 3, mode: 'date' }),
	lastSuccessAt: timestamp({ precision: 3, mode: 'date' }),
	createdByUserId: integer(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	domainIds: integer().array().default([]).notNull(),
}, (table) => [
	index("Webhook_teamId_idx").using("btree", table.teamId.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Webhook_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [user.id],
			name: "Webhook_createdByUserId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const emailEvent = pgTable("EmailEvent", {
	id: text().primaryKey().notNull(),
	emailId: text().notNull(),
	status: emailStatus().notNull(),
	data: jsonb(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	teamId: integer(),
}, (table) => [
	index("EmailEvent_createdAt_idx").using("btree", table.createdAt.asc().nullsLast()),
	index("EmailEvent_emailId_idx").using("btree", table.emailId.asc().nullsLast()),
	index("EmailEvent_teamId_idx").using("btree", table.teamId.asc().nullsLast()),
	foreignKey({
			columns: [table.emailId],
			foreignColumns: [email.id],
			name: "EmailEvent_emailId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const email = pgTable("Email", {
	id: text().primaryKey().notNull(),
	sesEmailId: text(),
	from: text().notNull(),
	to: text().array().default([]).notNull(),
	replyTo: text().array().default([]).notNull(),
	cc: text().array().default([]).notNull(),
	bcc: text().array().default([]).notNull(),
	subject: text().notNull(),
	text: text(),
	html: text(),
	latestStatus: emailStatus().default('QUEUED').notNull(),
	teamId: integer().notNull(),
	domainId: integer(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	attachments: text(),
	campaignId: text(),
	contactId: text(),
	scheduledAt: timestamp({ precision: 3, mode: 'date' }),
	apiId: integer(),
	inReplyToId: text(),
	headers: text(),
}, (table) => [
	index("Email_campaignId_contactId_idx").using("btree", table.campaignId.asc().nullsLast(), table.contactId.asc().nullsLast()),
	index("Email_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst()),
	uniqueIndex("Email_sesEmailId_key").using("btree", table.sesEmailId.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Email_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const template = pgTable("Template", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	teamId: integer().notNull(),
	subject: text().notNull(),
	html: text(),
	content: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	index("Template_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Template_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const teamInvite = pgTable("TeamInvite", {
	id: text().primaryKey().notNull(),
	teamId: integer().notNull(),
	email: text().notNull(),
	role: role().notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	uniqueIndex("TeamInvite_teamId_email_key").using("btree", table.teamId.asc().nullsLast(), table.email.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "TeamInvite_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const apiKey = pgTable("ApiKey", {
	id: serial().primaryKey().notNull(),
	clientId: text().notNull(),
	tokenHash: text().notNull(),
	partialToken: text().notNull(),
	name: text().notNull(),
	permission: apiPermission().default('SENDING').notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	lastUsed: timestamp({ precision: 3, mode: 'date' }),
	teamId: integer().notNull(),
	domainId: integer(),
}, (table) => [
	uniqueIndex("ApiKey_clientId_key").using("btree", table.clientId.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "ApiKey_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.domainId],
			foreignColumns: [domain.id],
			name: "ApiKey_domainId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const appSetting = pgTable("AppSetting", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
});

export const team = pgTable("Team", {
	id: serial().primaryKey().notNull(),
	name: text().notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	plan: plan().default('FREE').notNull(),
	stripeCustomerId: text(),
	billingEmail: text(),
	isActive: boolean().default(true).notNull(),
	apiRateLimit: integer().default(2).notNull(),
	sesTenantId: text(),
	dailyEmailLimit: integer().default(10000).notNull(),
	isBlocked: boolean().default(false).notNull(),
	isVerified: boolean().default(false).notNull(),
}, (table) => [
	uniqueIndex("Team_stripeCustomerId_key").using("btree", table.stripeCustomerId.asc().nullsLast()),
]);

export const contactBook = pgTable("ContactBook", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	teamId: integer().notNull(),
	properties: jsonb().notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	emoji: text().default('📙').notNull(),
	doubleOptInEnabled: boolean().default(false).notNull(),
	doubleOptInSubject: text(),
	doubleOptInContent: text(),
	variables: text().array().default([]).notNull(),
	doubleOptInFrom: text(),
}, (table) => [
	index("ContactBook_teamId_idx").using("btree", table.teamId.asc().nullsLast()),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "ContactBook_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const user = pgTable("User", {
	id: serial().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	image: text(),
	isBetaUser: boolean().default(false).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	isWaitlisted: boolean().default(false).notNull(),
	emailVerified: boolean().default(false).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("User_email_key").using("btree", table.email.asc().nullsLast()),
]);

export const campaignEmail = pgTable("CampaignEmail", {
	campaignId: text().notNull(),
	contactId: text().notNull(),
	emailId: text().notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.campaignId, table.contactId], name: "CampaignEmail_pkey"}),
]);

export const cumulatedMetrics = pgTable("CumulatedMetrics", {
	teamId: integer().notNull(),
	domainId: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	delivered: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hardBounced: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	complained: bigint({ mode: "number" }).default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.teamId, table.domainId], name: "CumulatedMetrics_pkey"}),
]);

export const dailyEmailUsage = pgTable("DailyEmailUsage", {
	teamId: integer().notNull(),
	date: text().notNull(),
	type: emailUsageType().notNull(),
	domainId: integer().notNull(),
	delivered: integer().default(0).notNull(),
	opened: integer().default(0).notNull(),
	clicked: integer().default(0).notNull(),
	bounced: integer().default(0).notNull(),
	complained: integer().default(0).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
	sent: integer().default(0).notNull(),
	hardBounced: integer().default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "DailyEmailUsage_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	// Column order matches the database: (teamId, domainId, date, type).
	// drizzle-kit pull listed these in table-definition order instead, which
	// would have silently rebuilt the backing index on a different prefix.
	primaryKey({ columns: [table.teamId, table.domainId, table.date, table.type], name: "DailyEmailUsage_pkey"}),
]);
