import { createRoute, z } from "@hono/zod-openapi";
import { PublicAPIApp } from "~/server/public-api/hono";
import { getTeamFromToken } from "~/server/public-api/auth";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { EmailStatus } from "@prisma/client";
import { UnsendApiError } from "../../api-error";

const route = createRoute({
  method: "get",
  path: "/v1/emails/{emailId}",
  request: {
    params: z.object({
      emailId: z
        .string()
        .min(3)
        .openapi({
          param: {
            name: "emailId",
            in: "path",
          },
          example: "cuiwqdj74rygf74",
        }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            teamId: z.number(),
            to: z.string().or(z.array(z.string())),
            replyTo: z.string().or(z.array(z.string())).optional(),
            cc: z.string().or(z.array(z.string())).optional(),
            bcc: z.string().or(z.array(z.string())).optional(),
            from: z.string(),
            subject: z.string(),
            html: z.string().nullable(),
            text: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
            emailEvents: z.array(
              z.object({
                emailId: z.string(),
                status: z.nativeEnum(EmailStatus),
                createdAt: z.string(),
                data: z.any().optional(),
              })
            ),
          }),
        },
      },
      description: "Retrieve the email",
    },
  },
});

function send(app: PublicAPIApp) {
  app.openapi(route, async (c) => {
    const team = c.var.team;
    const emailId = c.req.param("emailId");

    const email = await drizzleDb.query.email.findFirst({
      where: and(
        eq(schema.email.id, emailId),
        eq(schema.email.teamId, team.id),
        // Domain-restricted keys only see their own domain's emails.
        team.apiKey.domainId !== null
          ? eq(schema.email.domainId, team.apiKey.domainId)
          : undefined,
      ),
      columns: {
        id: true,
        teamId: true,
        to: true,
        from: true,
        subject: true,
        html: true,
        text: true,
        createdAt: true,
        updatedAt: true,
      },
      with: {
        emailEvents: {
          columns: {
            emailId: true,
            status: true,
            createdAt: true,
            data: true,
          },
        },
      },
    });

    if (!email) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Email not found",
      });
    }

    return c.json({
      ...email,
      // Column is nullable in the DB but the API contract says non-null.
      to: email.to ?? [],
    });
  });
}

export default send;
