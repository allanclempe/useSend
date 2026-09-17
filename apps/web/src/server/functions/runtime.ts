import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { drizzleDb } from "~/server/drizzle";
import { isWorkersRuntime } from "~/server/runtime";
import { getWorkerBindings } from "~/server/worker-bindings";

/**
 * What the server half of the app can actually reach, right now.
 *
 * This exists so the scaffold has something falsifiable to show: a server
 * function that reads the Worker's bindings and round-trips the database
 * proves the Vite build, the `workerd` isolate, the Hyperdrive binding and the
 * request-scoped Drizzle client are all wired to each other. It carries no
 * data and needs no session, so it is safe to leave unauthenticated.
 *
 * `/api/health` on the Hono app answers the same question for the public API
 * and is the one a load balancer should use; this one is for a human.
 */
export const runtimeFacts = createServerFn({ method: "GET" }).handler(
  async () => {
    const bindings = getWorkerBindings();

    let database = "unreachable";
    try {
      await drizzleDb.execute(sql`select 1`);
      database = "ok";
    } catch (error) {
      database = error instanceof Error ? error.name : "unreachable";
    }

    return {
      runtime: isWorkersRuntime() ? "workerd" : "node",
      bindings: bindings
        ? ["HYPERDRIVE", "CACHE", "STORAGE"].filter((name) =>
            Boolean((bindings as Record<string, unknown>)[name]),
          )
        : [],
      database,
      at: new Date().toISOString(),
    };
  },
);
