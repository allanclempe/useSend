import { createRoute, z } from "@hono/zod-openapi";
import { PublicAPIApp } from "~/server/public-api/hono";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";

const route = createRoute({
  method: "put",
  path: "/v1/domains/{id}/verify",
  request: {
    params: z.object({
      id: z.coerce.number().openapi({
        param: {
          name: "id",
          in: "path",
        },
        example: 1,
      }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
      description: "Verify domain",
    },
    403: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Forbidden - API key doesn't have access to this domain",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Domain not found",
    },
  },
});

function verifyDomain(app: PublicAPIApp) {
  app.openapi(route, async (c) => {
    const team = c.var.team;
    const domainId = c.req.valid("param").id;

    // A domain-restricted API key may only verify its own domain; anything
    // else falls through with `domain` unset and 404s below.
    const restricted = team.apiKey.domainId !== null;
    const allowed = !restricted || domainId === team.apiKey.domainId;

    const [domain] = allowed
      ? await drizzleDb
          .select()
          .from(schema.domain)
          .where(
            and(
              eq(schema.domain.teamId, team.id),
              eq(schema.domain.id, domainId),
            ),
          )
          .limit(1)
      : [];

    if (!domain) {
      return c.json({
        error: restricted
          ? "API key doesn't have access to this domain"
          : "Domain not found",
      }, 404);
    }

    await drizzleDb
      .update(schema.domain)
      .set(withUpdatedAt({ isVerifying: true }))
      .where(eq(schema.domain.id, domainId));

    return c.json({
      message: "Domain verification started",
    });
  });
}

export default verifyDomain;
