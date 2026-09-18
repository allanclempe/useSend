import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import {
  apiKeyMiddleware,
  campaignMiddleware,
  contactBookMiddleware,
  domainMiddleware,
  emailMiddleware,
  templateMiddleware,
} from "~/server/functions/middleware";

/**
 * The resource loaders' validators must not strip.
 *
 * Start runs validators in a chain, feeding each one the previous one's
 * output, so a loader that parsed with a plain `z.object()` would delete the
 * fields the server function declared for itself before that function's own
 * validator ever ran — `updateDomain({ data: { id, clickTracking } })` would
 * arrive as `{}`, with no error anywhere. This asserts the one property that
 * prevents it.
 */

const validatorOf = (middleware: unknown) =>
  (middleware as { options: { validator: ZodTypeAny } }).options.validator;

describe("resource middleware validators", () => {
  it.each([
    ["domain", domainMiddleware, { id: 1 }],
    ["email", emailMiddleware, { id: "email_1" }],
    ["apiKey", apiKeyMiddleware, { id: 1 }],
    ["contactBook", contactBookMiddleware, { contactBookId: "cb_1" }],
    ["campaign", campaignMiddleware, { campaignId: "c_1" }],
    ["template", templateMiddleware, { templateId: "t_1" }],
  ])("%s keeps the function's own fields", (_name, middleware, identity) => {
    const parsed = validatorOf(middleware).parse({
      ...identity,
      somethingTheFunctionDeclared: true,
    });

    expect(parsed).toEqual({
      ...identity,
      somethingTheFunctionDeclared: true,
    });
  });
});
