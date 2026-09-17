// GENERATED FILE — do not edit.
// Regenerate with: pnpm --filter=web db:drizzle-pull
// Introspected from the live database; see scripts/drizzle-pull.js for the
// fixups applied on top of drizzle-kit's output.
/* eslint-disable */

import { pgTable, varchar, timestamp, text, integer, uniqueIndex, boolean, foreignKey, index, jsonb, serial, primaryKey, bigint, pgEnum } from "drizzle-orm/pg-core"
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


export const appSetting = pgTable("AppSetting", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
});

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
	uniqueIndex("SesSetting_idPrefix_key").using("btree", table.idPrefix.asc().nullsLast().op("text_ops")),
	uniqueIndex("SesSetting_region_key").using("btree", table.region.asc().nullsLast().op("text_ops")),
]);

export const verificationToken = pgTable("VerificationToken", {
	identifier: text().notNull(),
	token: text().notNull(),
	expires: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	uniqueIndex("VerificationToken_identifier_token_key").using("btree", table.identifier.asc().nullsLast().op("text_ops"), table.token.asc().nullsLast().op("text_ops")),
	uniqueIndex("VerificationToken_token_key").using("btree", table.token.asc().nullsLast().op("text_ops")),
]);

export const account = pgTable("Account", {
	id: text().primaryKey().notNull(),
	userId: integer().notNull(),
	type: text().notNull(),
	provider: text().notNull(),
	providerAccountId: text().notNull(),
	refreshToken: text("refresh_token"),
	accessToken: text("access_token"),
	refreshTokenExpiresIn: integer("refresh_token_expires_in"),
	expiresAt: integer("expires_at"),
	tokenType: text("token_type"),
	scope: text(),
	idToken: text("id_token"),
	sessionState: text("session_state"),
}, (table) => [
	uniqueIndex("Account_provider_providerAccountId_key").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.providerAccountId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "Account_userId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const session = pgTable("Session", {
	id: text().primaryKey().notNull(),
	sessionToken: text().notNull(),
	userId: integer().notNull(),
	expires: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	uniqueIndex("Session_sessionToken_key").using("btree", table.sessionToken.asc().nullsLast().op("text_ops")),
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
	uniqueIndex("TeamUser_teamId_userId_key").using("btree", table.teamId.asc().nullsLast().op("int4_ops"), table.userId.asc().nullsLast().op("int4_ops")),
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

export const emailEvent = pgTable("EmailEvent", {
	id: text().primaryKey().notNull(),
	emailId: text().notNull(),
	status: emailStatus().notNull(),
	data: jsonb(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	teamId: integer(),
}, (table) => [
	index("EmailEvent_createdAt_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
	index("EmailEvent_emailId_idx").using("btree", table.emailId.asc().nullsLast().op("text_ops")),
	index("EmailEvent_teamId_idx").using("btree", table.teamId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.emailId],
			foreignColumns: [email.id],
			name: "EmailEvent_emailId_fkey"
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
	uniqueIndex("ApiKey_clientId_key").using("btree", table.clientId.asc().nullsLast().op("text_ops")),
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
	index("Email_campaignId_contactId_idx").using("btree", table.campaignId.asc().nullsLast().op("text_ops"), table.contactId.asc().nullsLast().op("text_ops")),
	index("Email_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamp_ops")),
	uniqueIndex("Email_sesEmailId_key").using("btree", table.sesEmailId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Email_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const user = pgTable("User", {
	id: serial().primaryKey().notNull(),
	name: text(),
	email: text(),
	emailVerified: timestamp({ precision: 3, mode: 'date' }),
	image: text(),
	isBetaUser: boolean().default(false).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	isWaitlisted: boolean().default(false).notNull(),
}, (table) => [
	uniqueIndex("User_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
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
	uniqueIndex("Domain_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Domain_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

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
	uniqueIndex("Team_stripeCustomerId_key").using("btree", table.stripeCustomerId.asc().nullsLast().op("text_ops")),
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
	index("ContactBook_teamId_idx").using("btree", table.teamId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "ContactBook_teamId_fkey"
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
	uniqueIndex("Contact_contactBookId_email_key").using("btree", table.contactBookId.asc().nullsLast().op("text_ops"), table.email.asc().nullsLast().op("text_ops")),
	index("Contact_contactBookId_id_idx").using("btree", table.contactBookId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.contactBookId],
			foreignColumns: [contactBook.id],
			name: "Contact_contactBookId_fkey"
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
	index("Template_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamp_ops")),
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
	uniqueIndex("TeamInvite_teamId_email_key").using("btree", table.teamId.asc().nullsLast().op("int4_ops"), table.email.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "TeamInvite_teamId_fkey"
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

export const suppressionList = pgTable("SuppressionList", {
	id: text().primaryKey().notNull(),
	email: text().notNull(),
	teamId: integer().notNull(),
	reason: suppressionReason().notNull(),
	source: text(),
	createdAt: timestamp({ precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	uniqueIndex("SuppressionList_teamId_email_key").using("btree", table.teamId.asc().nullsLast().op("int4_ops"), table.email.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "SuppressionList_teamId_fkey"
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
	index("Campaign_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamp_ops")),
	index("Campaign_status_scheduledAt_idx").using("btree", table.status.asc().nullsLast().op("timestamp_ops"), table.scheduledAt.asc().nullsLast().op("timestamp_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "Campaign_teamId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
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
	index("WebhookCall_createdAt_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamp_ops")),
	index("WebhookCall_teamId_webhookId_status_idx").using("btree", table.teamId.asc().nullsLast().op("int4_ops"), table.webhookId.asc().nullsLast().op("int4_ops"), table.status.asc().nullsLast().op("int4_ops")),
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
	index("Webhook_teamId_idx").using("btree", table.teamId.asc().nullsLast().op("int4_ops")),
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
	primaryKey({ columns: [table.teamId, table.date, table.type, table.domainId], name: "DailyEmailUsage_pkey"}),
]);
