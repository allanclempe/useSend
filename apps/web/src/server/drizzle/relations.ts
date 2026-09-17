import { relations } from "drizzle-orm/relations";
import { user, account, session, team, teamUser, email, emailEvent, apiKey, domain, contactBook, contact, template, teamInvite, subscription, suppressionList, campaign, webhook, webhookCall, dailyEmailUsage } from "./schema";

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));

export const userRelations = relations(user, ({many}) => ({
	accounts: many(account),
	sessions: many(session),
	teamUsers: many(teamUser),
	webhooks: many(webhook),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const teamUserRelations = relations(teamUser, ({one}) => ({
	team: one(team, {
		fields: [teamUser.teamId],
		references: [team.id]
	}),
	user: one(user, {
		fields: [teamUser.userId],
		references: [user.id]
	}),
}));

export const teamRelations = relations(team, ({many}) => ({
	teamUsers: many(teamUser),
	apiKeys: many(apiKey),
	emails: many(email),
	domains: many(domain),
	contactBooks: many(contactBook),
	templates: many(template),
	teamInvites: many(teamInvite),
	subscriptions: many(subscription),
	suppressionLists: many(suppressionList),
	campaigns: many(campaign),
	webhookCalls: many(webhookCall),
	webhooks: many(webhook),
	dailyEmailUsages: many(dailyEmailUsage),
}));

export const emailEventRelations = relations(emailEvent, ({one}) => ({
	email: one(email, {
		fields: [emailEvent.emailId],
		references: [email.id]
	}),
}));

export const emailRelations = relations(email, ({one, many}) => ({
	emailEvents: many(emailEvent),
	team: one(team, {
		fields: [email.teamId],
		references: [team.id]
	}),
}));

export const apiKeyRelations = relations(apiKey, ({one}) => ({
	team: one(team, {
		fields: [apiKey.teamId],
		references: [team.id]
	}),
	domain: one(domain, {
		fields: [apiKey.domainId],
		references: [domain.id]
	}),
}));

export const domainRelations = relations(domain, ({one, many}) => ({
	apiKeys: many(apiKey),
	team: one(team, {
		fields: [domain.teamId],
		references: [team.id]
	}),
}));

export const contactBookRelations = relations(contactBook, ({one, many}) => ({
	team: one(team, {
		fields: [contactBook.teamId],
		references: [team.id]
	}),
	contacts: many(contact),
}));

export const contactRelations = relations(contact, ({one}) => ({
	contactBook: one(contactBook, {
		fields: [contact.contactBookId],
		references: [contactBook.id]
	}),
}));

export const templateRelations = relations(template, ({one}) => ({
	team: one(team, {
		fields: [template.teamId],
		references: [team.id]
	}),
}));

export const teamInviteRelations = relations(teamInvite, ({one}) => ({
	team: one(team, {
		fields: [teamInvite.teamId],
		references: [team.id]
	}),
}));

export const subscriptionRelations = relations(subscription, ({one}) => ({
	team: one(team, {
		fields: [subscription.teamId],
		references: [team.id]
	}),
}));

export const suppressionListRelations = relations(suppressionList, ({one}) => ({
	team: one(team, {
		fields: [suppressionList.teamId],
		references: [team.id]
	}),
}));

export const campaignRelations = relations(campaign, ({one}) => ({
	team: one(team, {
		fields: [campaign.teamId],
		references: [team.id]
	}),
}));

export const webhookCallRelations = relations(webhookCall, ({one}) => ({
	webhook: one(webhook, {
		fields: [webhookCall.webhookId],
		references: [webhook.id]
	}),
	team: one(team, {
		fields: [webhookCall.teamId],
		references: [team.id]
	}),
}));

export const webhookRelations = relations(webhook, ({one, many}) => ({
	webhookCalls: many(webhookCall),
	team: one(team, {
		fields: [webhook.teamId],
		references: [team.id]
	}),
	user: one(user, {
		fields: [webhook.createdByUserId],
		references: [user.id]
	}),
}));

export const dailyEmailUsageRelations = relations(dailyEmailUsage, ({one}) => ({
	team: one(team, {
		fields: [dailyEmailUsage.teamId],
		references: [team.id]
	}),
}));