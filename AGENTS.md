# Repository Guidelines

## Project Structure & Module Organization

- apps/web: Next.js app (primary product). Uses Drizzle, TRPC, Tailwind.
- apps/marketing: Public marketing site (Next.js, static export).
- apps/docs: Mintlify docs content.
- apps/smtp-server: SMTP proxy/server (TypeScript → tsup build).
- packages/\*: Shared libraries (email-editor, ui, eslint-config, tailwind-config, typescript-config, sdk).
- docker/: Dev/compose files; .env\* at repo root define configuration.
- The dev database is Neon Local (`docker/dev/compose.yml`), a proxy to a real Neon branch — not a local Postgres container. It needs `NEON_PROJECT_ID`, `NEON_API_KEY` and `NEON_BRANCH_ID`, read from the root `.env` (the `dx` scripts pass `--project-directory .` so compose sees it) or from `.envrc` via direnv. In a git worktree, source the main checkout's `.envrc` with `source_env "$(git rev-parse --git-common-dir)/../.envrc"`. Connect on `postgres://neon:npg@localhost:54320/neondb?sslmode=require`. `docker/testing/compose.yml` is still plain postgres:16.

## Build, Test, and Development Commands

- `pnpm i`: Install workspace deps (Node >= 20).
- `pnpm dev`: Turbo dev for all relevant apps (loads `.env`).
- `pnpm start:web:local`: Run only `apps/web` locally on port 3000.
- `pnpm build`: Turbo build across the monorepo.
- `pnpm dx` / `pnpm dx:up` / `pnpm dx:down`: Spin up/down local infra via Docker Compose, then run migrations.
- Database (apps/web filter): `db:generate` | `db:migrate` | `db:push` | `db:studio`.
- Migrations are drizzle-kit's, in `apps/web/src/server/drizzle/migrations`. The workflow is: edit
  `src/server/drizzle/schema.ts` (the hand-authored source of truth), run `pnpm --filter=web
  db:generate` to write the SQL, then read the generated SQL before committing — drizzle-kit infers
  intent from a schema diff and cannot tell a rename from a drop-and-add. `db:migrate` applies
  migrations. There is no introspection step: nothing regenerates `schema.ts`.
- drizzle-kit's journal is `drizzle.__drizzle_migrations`, in its own `drizzle` schema, so every
  table in `public` is a domain table.
- Database types and enums come from `~/types/db`, never from an ORM package directly. It is the
  one seam over `src/server/drizzle/schema.ts`: enum values (`EmailStatus.SENT`), row types
  (`Campaign`, `Domain`) and `JsonValue`. It is client-safe — it imports the schema with
  `import type`, so adding a value import there would pull the whole schema into the browser
  bundle.
- Never run migrations unless users explicitly asked

## Coding Style & Naming Conventions

- Files: React components PascalCase (e.g., `AppSideBar.tsx`); folders kebab/lowercase.
- Paths (web): use alias `~/` for src imports (e.g., `import { x } from "~/utils/x"`).
- NEVER USE DYNAMIC IMPORTS. ALWAYS IMPORT ON THE TOP

## Dependencies

- pnpm settings live in `pnpm-workspace.yaml` — `overrides`, `packageExtensions`, `allowBuilds`. The
  `"pnpm"` field in root `package.json` is a duplicate that pnpm 11 ignores (issue #55); edit the
  workspace file, and mirror into `package.json` only while that issue is open.
- **A package that imports something it never declared resolves it by hoist order, so adding an
  unrelated dependency can silently change which version it gets.** `@hookform/resolvers` imports
  `zod` with neither a dependency nor a peer on it. It got zod 3 until `better-auth` put zod 4 in the
  tree and won the hoist — which retyped every `zodResolver(...)` call against the wrong major and
  broke `typecheck` in six components nobody had edited.
- Fix that by declaring the missing dependency in `packageExtensions`, not by casting at the call
  sites. A cast hides a real version mismatch and has to be repeated; the declaration states what the
  package actually needs and survives the next install.
- After adding any dependency, run `pnpm --filter=web typecheck` before assuming the change is
  contained. A new transitive major of a shared library — zod, react, drizzle — surfaces as type
  errors in files the change never touched.

## Rules

- Prefer to use trpc alway unless asked otherwise
- **Do not add work to the SES event pipeline to learn something we already
  know.** Every subscribed SES event costs an SNS POST, a queue message and a
  consumer invocation per email, and the pipeline is the single largest line in
  the cost model. `SEND` was dropped for exactly this reason (issue #2): the
  facts it carried — `DailyEmailUsage.sent`, `Email.latestStatus = SENT`, the
  `email.sent` webhook, `Campaign.sent` — are all recorded locally now, at
  enqueue and at the SES handoff, where they arrive sooner and cannot be
  delayed, dropped or replayed. Reach for an SES subscription only for facts
  that originate at SES: bounces, complaints, deliveries, rejects.
- **Counters that feed billing need a database-side idempotency guard, not a
  queue-side one.** `DailyEmailUsage.sent` is gated on `Email.usageCountedAt`
  making a one-way transition in the same statement as the increment.
  `EnqueueOptions.jobId` dedup looks like it would do the job, but it is a
  BullMQ affordance and Cloudflare Queues has no equivalent, so anything built
  on it stops working mid-migration — silently, and in the direction of
  overcharging.

## Testing Guidelines

- Web testing is configured with Vitest in `apps/web`; add tests when changes impact logic, APIs, or behavior.
- Prefer targeted suites first: `pnpm test:web:unit`, `pnpm test:web:trpc`, `pnpm test:web:api`; use `pnpm test:web` for default non-integration coverage.
- Test file conventions: `*.unit.test.ts`, `*.trpc.test.ts`, `*.api.test.ts`, `*.integration.test.ts`.
- Choose the suite by what is under test, not by what the code touches. Logic — branching, validation, defaults, which notification fires — belongs in a unit test with its edges faked. Queries belong in an integration test against the real database: a mocked query builder only ever asserts the arguments you passed it, never what the query did.
- Do not assert on the shape of a database call (`expect(mockDb.x.update).toHaveBeenCalledWith(...)`). That restates the input and passes even when the query is wrong. Assert on the row that came back, or capture the payload the builder actually received.
- Integration tests require infra and env (`RUN_INTEGRATION=true` with Postgres/Redis available). Root commands `pnpm test:web:all` and `pnpm test:web:integration:full` auto-manage infra lifecycle.
- Use `pnpm test:infra:up` / `pnpm test:infra:down` when running targeted integration commands manually.
- `pnpm test:web:integration:full` and `test:integration:prepare` run migrations (`drizzle-kit migrate`); never run these unless the user explicitly asks, because they take `DATABASE_URL` from the environment and will migrate whatever it points at. The one safe path is `test:integration:prepare:local`, which `pnpm test:web:all` uses: its `DATABASE_URL` is hardcoded to the `usesend_test` container that `test:infra:up`/`down` creates and destroys per run, so it cannot reach a dev or production database. It takes an empty container to the current schema.
- Test defaults are cloud mode (`NEXT_PUBLIC_IS_CLOUD=true`); keep new tests compatible with cloud behavior unless the task says otherwise.
- Run the tests when you finish a change, before reporting it done. Always `pnpm --filter=web typecheck`, then the suites your change touches; use `pnpm test:web:all` when it touches services, queues, jobs, or the database. Report what you actually ran and what it said — if a suite was skipped or failed, say so rather than describing the change as complete.

## Commit & Pull Request Guidelines

- Prefer Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Git history shows frequent feat/fix usage.
- Track the issue number as the commit scope: `feat(#42): …`, `refactor(#3): …`. Applies to PR titles too, since a squash merge uses the title as the subject. Still put `Closes #nnn` in the body — the scope alone does not close the issue.
- PRs must include: clear description, linked issues, screenshots for UI changes, migration notes, and verification steps.
- never run build,migration commands unless asked for
