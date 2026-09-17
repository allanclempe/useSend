import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  requireActiveUser,
  requireApiKey,
  requireCampaign,
  requireContactBook,
  requireDomain,
  requireEmail,
  requireInstanceAdmin,
  requireTeam,
  requireTeamAdmin,
  requireTemplate,
  requireUser,
} from "~/server/authorization";
import { getChildLogger, withLogger } from "~/server/logger/log";
import {
  newTraceContext,
  withTraceContext,
} from "~/server/logger/trace-context";

/**
 * The procedure ladder from `server/api/trpc.ts`, as TanStack Start
 * middleware (#9).
 *
 * Every one of these is three lines of glue over `~/server/authorization`,
 * which is where the rules live and where they are tested. The split is
 * deliberate: an authorisation rule that can only run inside a request is an
 * authorisation rule nobody reads.
 *
 * Use them the way the procedures were used — pick the tightest one that
 * still lets the handler do its job, and take `teamId` from `context`, never
 * from the caller's input.
 */

/** `authedProcedure` — signed in, waitlisted or not. */
export const authedMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const user = await requireUser(getRequest().headers);
    return next({ context: { user } });
  },
);

/** `protectedProcedure` — signed in and past the waitlist. */
export const protectedMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const user = await requireActiveUser(getRequest().headers);
  return next({ context: { user } });
});

/**
 * `teamProcedure` — the caller, their team, and a trace.
 *
 * The trace is not decoration. A dashboard call enqueues jobs, and the queue
 * seam carries `traceparent` across the hop, so the consumer that runs the
 * work logs under the same `trace_id` as the click that caused it (#18). This
 * is the entry point for that, which is why it wraps `next()` rather than
 * running before it.
 */
export const teamMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const { user, team, teamUser } = await requireTeam(getRequest().headers);

    return withTraceContext(newTraceContext(), () =>
      withLogger(
        getChildLogger({ teamId: team.id, requestId: randomUUID() }),
        () => next({ context: { user, team, teamUser } }),
      ),
    );
  },
);

/** `teamAdminProcedure`. */
export const teamAdminMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const { user, team, teamUser } = await requireTeamAdmin(getRequest().headers);

  return withTraceContext(newTraceContext(), () =>
    withLogger(
      getChildLogger({ teamId: team.id, requestId: randomUUID() }),
      () => next({ context: { user, team, teamUser } }),
    ),
  );
});

/** `adminProcedure` — whoever runs this installation. */
export const instanceAdminMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const user = await requireInstanceAdmin(getRequest().headers);
  return next({ context: { user } });
});

/**
 * The resource loaders.
 *
 * Each declares the input it needs, so a server function that uses one
 * inherits that field in its own validator — `domainMiddleware` means the
 * function takes `{ id: number }` whether or not it says so. That is how the
 * tRPC versions worked (`domainProcedure.input(z.object({ id }))`) and it is
 * the property that makes the ownership check unskippable: you cannot name
 * the resource without going through the lookup that scopes it to your team.
 *
 * **Every one of them is `.passthrough()`, and it is not optional.** Start
 * chains validators by feeding each one the *previous* one's output, so a
 * plain `z.object()` here strips the fields the server function declared for
 * itself before its own validator ever sees them: `updateDomain({ data: { id,
 * clickTracking } })` would reach the handler as `{}`. No error, no warning —
 * the field is simply gone. tRPC merged inputs instead, which is why the
 * routers never had to think about this.
 *
 * The mirror image still applies and cannot be fixed here: the *function's*
 * own validator strips the loader's field, so `data.id` is absent in any
 * handler that declares a validator of its own — even though the inferred
 * type of `data` claims it is there. **Read the resource from `context`**
 * (`context.domain.id`, `context.contactBook.id`, …), never from `data`.
 * That is what the loader put it there for.
 */

export const domainMiddleware = createMiddleware({ type: "function" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.number() }).passthrough())
  .server(async ({ next, data, context }) => {
    const domain = await requireDomain(context.team.id, data.id);
    return next({ context: { domain } });
  });

export const emailMiddleware = createMiddleware({ type: "function" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string() }).passthrough())
  .server(async ({ next, data, context }) => {
    const email = await requireEmail(context.team.id, data.id);
    return next({ context: { email } });
  });

export const apiKeyMiddleware = createMiddleware({ type: "function" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.number() }).passthrough())
  .server(async ({ next, data, context }) => {
    const apiKey = await requireApiKey(context.team.id, data.id);
    return next({ context: { apiKey } });
  });

export const contactBookMiddleware = createMiddleware({ type: "function" })
  .middleware([teamMiddleware])
  .validator(z.object({ contactBookId: z.string() }).passthrough())
  .server(async ({ next, data, context }) => {
    const contactBook = await requireContactBook(
      context.team.id,
      data.contactBookId,
    );
    return next({ context: { contactBook } });
  });

export const campaignMiddleware = createMiddleware({ type: "function" })
  .middleware([teamMiddleware])
  .validator(z.object({ campaignId: z.string() }).passthrough())
  .server(async ({ next, data, context }) => {
    const campaign = await requireCampaign(context.team.id, data.campaignId);
    return next({ context: { campaign } });
  });

export const templateMiddleware = createMiddleware({ type: "function" })
  .middleware([teamMiddleware])
  .validator(z.object({ templateId: z.string() }).passthrough())
  .server(async ({ next, data, context }) => {
    const template = await requireTemplate(context.team.id, data.templateId);
    return next({ context: { template } });
  });
