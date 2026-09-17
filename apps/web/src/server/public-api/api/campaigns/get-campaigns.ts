import { createRoute, z } from "@hono/zod-openapi";
import { CampaignStatus } from "@prisma/client";
import { PublicAPIApp } from "~/server/public-api/hono";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";

const statuses = Object.values(CampaignStatus) as [CampaignStatus];

const route = createRoute({
	method: "get",
	path: "/v1/campaigns",
	request: {
		query: z.object({
			page: z.string().optional().openapi({
				description: "Page number for pagination (default: 1)",
				example: "1",
			}),
			status: z.enum(statuses).optional().openapi({
				description: "Filter campaigns by status",
				example: "DRAFT",
			}),
			search: z.string().optional().openapi({
				description: "Search campaigns by name or subject",
				example: "newsletter",
			}),
		}),
	},
	responses: {
		200: {
			description: "Get list of campaigns",
			content: {
				"application/json": {
					schema: z.object({
						campaigns: z.array(
							z.object({
								id: z.string(),
								name: z.string(),
								from: z.string(),
								subject: z.string(),
								createdAt: z.string().datetime(),
								updatedAt: z.string().datetime(),
								status: z.string(),
								scheduledAt: z.string().datetime().nullable(),
								total: z.number().int(),
								sent: z.number().int(),
								delivered: z.number().int(),
								unsubscribed: z.number().int(),
							})
						),
						totalPage: z.number().int(),
					}),
				},
			},
		},
	},
});

function getCampaigns(app: PublicAPIApp) {
	app.openapi(route, async (c) => {
		const team = c.var.team;
		const pageParam = c.req.query("page");
		const statusParam = c.req.query("status") as CampaignStatus | undefined;
		const searchParam = c.req.query("search");

		const page = pageParam ? Number(pageParam) : 1;
		const limit = 30;
		const offset = (page - 1) * limit;

		const where = and(
			eq(schema.campaign.teamId, team.id),
			statusParam ? eq(schema.campaign.status, statusParam) : undefined,
			// Prisma's `contains` with mode "insensitive".
			searchParam
				? or(
						ilike(schema.campaign.name, `%${searchParam}%`),
						ilike(schema.campaign.subject, `%${searchParam}%`),
					)
				: undefined,
		);

		const countP = drizzleDb.$count(schema.campaign, where);

		const campaignsP = drizzleDb
			.select({
				id: schema.campaign.id,
				name: schema.campaign.name,
				from: schema.campaign.from,
				subject: schema.campaign.subject,
				createdAt: schema.campaign.createdAt,
				updatedAt: schema.campaign.updatedAt,
				status: schema.campaign.status,
				scheduledAt: schema.campaign.scheduledAt,
				total: schema.campaign.total,
				sent: schema.campaign.sent,
				delivered: schema.campaign.delivered,
				unsubscribed: schema.campaign.unsubscribed,
			})
			.from(schema.campaign)
			.orderBy(desc(schema.campaign.createdAt))
			.where(where)
			.offset(offset)
			.limit(limit);

		const [campaigns, count] = await Promise.all([campaignsP, countP]);

		return c.json({ campaigns, totalPage: Math.ceil(count / limit) });
	});
}

export default getCampaigns;
