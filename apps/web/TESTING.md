# Testing in `apps/web`

This app has three testing layers:

- Unit tests (`*.unit.test.ts`)
- API tests (`*.api.test.ts`)
- Infra-backed integration tests (`*.integration.test.ts`)

## Stack

- Runner: Vitest
- Coverage: V8 provider via `@vitest/coverage-v8`
- Path aliases: `vite-tsconfig-paths`
- Infra for integration: PostgreSQL via Docker Compose. Nothing else — the
  cache, rate limiter, idempotency store and webhook dispatcher are Worker
  bindings, supplied in memory by `src/test/integration/bindings.ts` (#12).

## Commands

From repo root:

- `pnpm test:web`
- `pnpm test:web:all`
- `pnpm test:web:unit`
- `pnpm test:web:api`
- `pnpm test:web:integration`
- `pnpm test:web:integration:full`

Infra helpers:

- `pnpm test:infra:up`
- `pnpm test:infra:down`

Full integration flow:

1. `pnpm test:infra:up`
2. `pnpm test:web:integration:full` (or `pnpm test:web:all`)
3. `pnpm test:infra:down`

## Infra configuration

- Compose file: `docker/testing/compose.yml`
- Postgres: `127.0.0.1:54329` (`usesend_test`)

The default test env is bootstrapped in `src/test/setup/setup-env.ts`.
Override values by exporting env vars before running tests.

## Test layout

- `src/test/setup/*`: global test bootstrap, including the `cloudflare:workers`
  shim that lets a Durable Object class load outside a Worker
- `src/test/integration/*`: integration reset helpers and the in-memory Worker
  bindings
- Tests colocated next to modules under `src/**`

## Notes

- Integration suites only run when `RUN_INTEGRATION=true`.
- Integration helpers truncate all public Postgres tables (`resetDatabase`) and clear the binding state (`resetWorkerBindings`) before each test. drizzle-kit keeps its migration journal in a separate `drizzle` schema, so there is no bookkeeping table in `public` to exclude.
- The bindings are installed by importing `src/test/integration/helpers.ts`, not by a `setupFiles` entry, and that is load-bearing — see the comment there before moving it.

## CI

GitHub Actions workflow: `.github/workflows/test-web.yml`

The workflow runs unit, API and integration tests against a PostgreSQL service.
