CREATE TYPE "public"."ApiPermission" AS ENUM('FULL', 'SENDING');--> statement-breakpoint
CREATE TYPE "public"."CampaignStatus" AS ENUM('DRAFT', 'SCHEDULED', 'SENT', 'RUNNING', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."DomainStatus" AS ENUM('NOT_STARTED', 'PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE');--> statement-breakpoint
CREATE TYPE "public"."EmailStatus" AS ENUM('SCHEDULED', 'CANCELLED', 'RENDERING_FAILURE', 'QUEUED', 'SENT', 'REJECTED', 'DELIVERY_DELAYED', 'DELIVERED', 'BOUNCED', 'OPENED', 'CLICKED', 'COMPLAINED', 'FAILED', 'SUPPRESSED');--> statement-breakpoint
CREATE TYPE "public"."EmailUsageType" AS ENUM('TRANSACTIONAL', 'MARKETING');--> statement-breakpoint
CREATE TYPE "public"."Plan" AS ENUM('FREE', 'BASIC');--> statement-breakpoint
CREATE TYPE "public"."Role" AS ENUM('ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."SuppressionReason" AS ENUM('HARD_BOUNCE', 'COMPLAINT', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."UnsubscribeReason" AS ENUM('BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED');--> statement-breakpoint
CREATE TYPE "public"."WebhookCallStatus" AS ENUM('PENDING', 'IN_PROGRESS', 'DELIVERED', 'FAILED', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."WebhookStatus" AS ENUM('ACTIVE', 'PAUSED', 'AUTO_DISABLED');--> statement-breakpoint
CREATE TABLE "Account" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" integer NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp (3),
	"refreshTokenExpiresAt" timestamp (3),
	"scope" text,
	"password" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ApiKey" (
	"id" serial PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"partialToken" text NOT NULL,
	"name" text NOT NULL,
	"permission" "ApiPermission" DEFAULT 'SENDING' NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"lastUsed" timestamp (3),
	"teamId" integer NOT NULL,
	"domainId" integer
);
--> statement-breakpoint
CREATE TABLE "AppSetting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Campaign" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"teamId" integer NOT NULL,
	"from" text NOT NULL,
	"cc" text[] DEFAULT '{}' NOT NULL,
	"bcc" text[] DEFAULT '{}' NOT NULL,
	"replyTo" text[] DEFAULT '{}' NOT NULL,
	"domainId" integer NOT NULL,
	"subject" text NOT NULL,
	"previewText" text,
	"html" text,
	"content" text,
	"contactBookId" text,
	"total" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"unsubscribed" integer DEFAULT 0 NOT NULL,
	"bounced" integer DEFAULT 0 NOT NULL,
	"complained" integer DEFAULT 0 NOT NULL,
	"status" "CampaignStatus" DEFAULT 'DRAFT' NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"hardBounced" integer DEFAULT 0 NOT NULL,
	"batchSize" integer DEFAULT 500 NOT NULL,
	"batchWindowMinutes" integer DEFAULT 0 NOT NULL,
	"lastCursor" text,
	"lastSentAt" timestamp (3),
	"scheduledAt" timestamp (3),
	"isApi" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "CampaignEmail" (
	"campaignId" text NOT NULL,
	"contactId" text NOT NULL,
	"emailId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "CampaignEmail_pkey" PRIMARY KEY("campaignId","contactId")
);
--> statement-breakpoint
CREATE TABLE "Contact" (
	"id" text PRIMARY KEY NOT NULL,
	"firstName" text,
	"lastName" text,
	"email" text NOT NULL,
	"subscribed" boolean DEFAULT true NOT NULL,
	"properties" jsonb NOT NULL,
	"contactBookId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"unsubscribeReason" "UnsubscribeReason"
);
--> statement-breakpoint
CREATE TABLE "ContactBook" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"teamId" integer NOT NULL,
	"properties" jsonb NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"emoji" text DEFAULT '📙' NOT NULL,
	"doubleOptInEnabled" boolean DEFAULT false NOT NULL,
	"doubleOptInSubject" text,
	"doubleOptInContent" text,
	"variables" text[] DEFAULT '{}' NOT NULL,
	"doubleOptInFrom" text
);
--> statement-breakpoint
CREATE TABLE "CumulatedMetrics" (
	"teamId" integer NOT NULL,
	"domainId" integer NOT NULL,
	"delivered" bigint DEFAULT 0 NOT NULL,
	"hardBounced" bigint DEFAULT 0 NOT NULL,
	"complained" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "CumulatedMetrics_pkey" PRIMARY KEY("teamId","domainId")
);
--> statement-breakpoint
CREATE TABLE "DailyEmailUsage" (
	"teamId" integer NOT NULL,
	"date" text NOT NULL,
	"type" "EmailUsageType" NOT NULL,
	"domainId" integer NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"bounced" integer DEFAULT 0 NOT NULL,
	"complained" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"hardBounced" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "DailyEmailUsage_pkey" PRIMARY KEY("teamId","domainId","date","type")
);
--> statement-breakpoint
CREATE TABLE "Domain" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"teamId" integer NOT NULL,
	"status" "DomainStatus" DEFAULT 'PENDING' NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"clickTracking" boolean DEFAULT false NOT NULL,
	"openTracking" boolean DEFAULT false NOT NULL,
	"publicKey" text NOT NULL,
	"dkimStatus" text,
	"spfDetails" text,
	"dmarcAdded" boolean DEFAULT false NOT NULL,
	"errorMessage" text,
	"subdomain" text,
	"isVerifying" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"sesTenantId" text,
	"dkimSelector" text DEFAULT 'usesend'
);
--> statement-breakpoint
CREATE TABLE "Email" (
	"id" text PRIMARY KEY NOT NULL,
	"sesEmailId" text,
	"from" text NOT NULL,
	"to" text[] DEFAULT '{}' NOT NULL,
	"replyTo" text[] DEFAULT '{}' NOT NULL,
	"cc" text[] DEFAULT '{}' NOT NULL,
	"bcc" text[] DEFAULT '{}' NOT NULL,
	"subject" text NOT NULL,
	"text" text,
	"html" text,
	"latestStatus" "EmailStatus" DEFAULT 'QUEUED' NOT NULL,
	"teamId" integer NOT NULL,
	"domainId" integer,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"attachments" text,
	"campaignId" text,
	"contactId" text,
	"scheduledAt" timestamp (3),
	"apiId" integer,
	"inReplyToId" text,
	"headers" text
);
--> statement-breakpoint
CREATE TABLE "EmailEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"emailId" text NOT NULL,
	"status" "EmailStatus" NOT NULL,
	"data" jsonb,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"teamId" integer
);
--> statement-breakpoint
CREATE TABLE "SesSetting" (
	"id" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"idPrefix" text NOT NULL,
	"topic" text NOT NULL,
	"topicArn" text,
	"callbackUrl" text NOT NULL,
	"callbackSuccess" boolean DEFAULT false NOT NULL,
	"configGeneral" text,
	"configGeneralSuccess" boolean DEFAULT false NOT NULL,
	"configClick" text,
	"configClickSuccess" boolean DEFAULT false NOT NULL,
	"configOpen" text,
	"configOpenSuccess" boolean DEFAULT false NOT NULL,
	"configFull" text,
	"configFullSuccess" boolean DEFAULT false NOT NULL,
	"sesEmailRateLimit" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"transactionalQuota" integer DEFAULT 50 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Session" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"userId" integer NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" integer NOT NULL,
	"status" text NOT NULL,
	"priceId" text NOT NULL,
	"currentPeriodEnd" timestamp (3),
	"currentPeriodStart" timestamp (3),
	"cancelAtPeriodEnd" timestamp (3),
	"paymentMethod" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"priceIds" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SuppressionList" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"teamId" integer NOT NULL,
	"reason" "SuppressionReason" NOT NULL,
	"source" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Team" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"plan" "Plan" DEFAULT 'FREE' NOT NULL,
	"stripeCustomerId" text,
	"billingEmail" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"apiRateLimit" integer DEFAULT 2 NOT NULL,
	"sesTenantId" text,
	"dailyEmailLimit" integer DEFAULT 10000 NOT NULL,
	"isBlocked" boolean DEFAULT false NOT NULL,
	"isVerified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TeamInvite" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" integer NOT NULL,
	"email" text NOT NULL,
	"role" "Role" NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TeamUser" (
	"teamId" integer NOT NULL,
	"userId" integer NOT NULL,
	"role" "Role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Template" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"teamId" integer NOT NULL,
	"subject" text NOT NULL,
	"html" text,
	"content" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"image" text,
	"isBetaUser" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"isWaitlisted" boolean DEFAULT false NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Verification" (
	"id" serial PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" integer NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"secret" text NOT NULL,
	"status" "WebhookStatus" DEFAULT 'ACTIVE' NOT NULL,
	"eventTypes" text[] DEFAULT '{}' NOT NULL,
	"apiVersion" text,
	"consecutiveFailures" integer DEFAULT 0 NOT NULL,
	"lastFailureAt" timestamp (3),
	"lastSuccessAt" timestamp (3),
	"createdByUserId" integer,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"domainIds" integer[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WebhookCall" (
	"id" text PRIMARY KEY NOT NULL,
	"webhookId" text NOT NULL,
	"teamId" integer NOT NULL,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"status" "WebhookCallStatus" DEFAULT 'PENDING' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp (3),
	"lastError" text,
	"responseStatus" integer,
	"responseTimeMs" integer,
	"responseText" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "public"."Domain"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_contactBookId_fkey" FOREIGN KEY ("contactBookId") REFERENCES "public"."ContactBook"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ContactBook" ADD CONSTRAINT "ContactBook_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "DailyEmailUsage" ADD CONSTRAINT "DailyEmailUsage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "public"."Email"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "SuppressionList" ADD CONSTRAINT "SuppressionList_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "TeamUser" ADD CONSTRAINT "TeamUser_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "TeamUser" ADD CONSTRAINT "TeamUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Template" ADD CONSTRAINT "Template_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "WebhookCall" ADD CONSTRAINT "WebhookCall_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "public"."Webhook"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "WebhookCall" ADD CONSTRAINT "WebhookCall_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE INDEX "Account_userId_idx" ON "Account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "ApiKey_clientId_key" ON "ApiKey" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign" USING btree ("createdAt" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "Campaign_status_scheduledAt_idx" ON "Campaign" USING btree ("status","scheduledAt");--> statement-breakpoint
CREATE UNIQUE INDEX "Contact_contactBookId_email_key" ON "Contact" USING btree ("contactBookId","email");--> statement-breakpoint
CREATE INDEX "Contact_contactBookId_id_idx" ON "Contact" USING btree ("contactBookId","id");--> statement-breakpoint
CREATE INDEX "ContactBook_teamId_idx" ON "ContactBook" USING btree ("teamId");--> statement-breakpoint
CREATE UNIQUE INDEX "Domain_name_key" ON "Domain" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Email_campaignId_contactId_idx" ON "Email" USING btree ("campaignId","contactId");--> statement-breakpoint
CREATE INDEX "Email_createdAt_idx" ON "Email" USING btree ("createdAt" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "Email_sesEmailId_key" ON "Email" USING btree ("sesEmailId");--> statement-breakpoint
CREATE INDEX "EmailEvent_createdAt_idx" ON "EmailEvent" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "EmailEvent_emailId_idx" ON "EmailEvent" USING btree ("emailId");--> statement-breakpoint
CREATE INDEX "EmailEvent_teamId_idx" ON "EmailEvent" USING btree ("teamId");--> statement-breakpoint
CREATE UNIQUE INDEX "SesSetting_idPrefix_key" ON "SesSetting" USING btree ("idPrefix");--> statement-breakpoint
CREATE UNIQUE INDEX "SesSetting_region_key" ON "SesSetting" USING btree ("region");--> statement-breakpoint
CREATE UNIQUE INDEX "Session_token_key" ON "Session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "Session_userId_idx" ON "Session" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "SuppressionList_teamId_email_key" ON "SuppressionList" USING btree ("teamId","email");--> statement-breakpoint
CREATE UNIQUE INDEX "Team_stripeCustomerId_key" ON "Team" USING btree ("stripeCustomerId");--> statement-breakpoint
CREATE UNIQUE INDEX "TeamInvite_teamId_email_key" ON "TeamInvite" USING btree ("teamId","email");--> statement-breakpoint
CREATE UNIQUE INDEX "TeamUser_teamId_userId_key" ON "TeamUser" USING btree ("teamId","userId");--> statement-breakpoint
CREATE INDEX "Template_createdAt_idx" ON "Template" USING btree ("createdAt" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "User_email_key" ON "User" USING btree ("email");--> statement-breakpoint
CREATE INDEX "Verification_identifier_idx" ON "Verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "Webhook_teamId_idx" ON "Webhook" USING btree ("teamId");--> statement-breakpoint
CREATE INDEX "WebhookCall_createdAt_idx" ON "WebhookCall" USING btree ("createdAt" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "WebhookCall_teamId_webhookId_status_idx" ON "WebhookCall" USING btree ("teamId","webhookId","status");