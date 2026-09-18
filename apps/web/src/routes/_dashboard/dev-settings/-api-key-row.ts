import type { getApiKeys } from "~/server/functions/api-key";

/**
 * One row of the API key table.
 *
 * `inferRouterOutputs<AppRouter>["apiKey"]["getApiKeys"]` was how the Next.js
 * components named this. A server function is a plain function, so its return
 * type is reachable directly and the three components that render a key agree
 * with the query that fetched it by construction.
 */
export type ApiKeyRow = Awaited<ReturnType<typeof getApiKeys>>[number];
