# Repository Guidelines

## Project Structure & Module Organization

- apps/web: Next.js app (primary product). Uses Prisma, TRPC, Tailwind.
- apps/marketing: Public marketing site (Next.js, static export).
- apps/docs: Mintlify docs content.
- apps/smtp-server: SMTP proxy/server (TypeScript → tsup build).
- packages/\*: Shared libraries (email-editor, ui, eslint-config, tailwind-config, typescript-config, sdk).
- docker/: Dev/compose files; .env\* at repo root define configuration.

## Build, Test, and Development Commands

- `pnpm i`: Install workspace deps (Node >= 20).
- `pnpm dev`: Turbo dev for all relevant apps (loads `.env`).
- `pnpm start:web:local`: Run only `apps/web` locally on port 3000.
- `pnpm build`: Turbo build across the monorepo.
- `pnpm dx` / `pnpm dx:up` / `pnpm dx:down`: Spin up/down local infra via Docker Compose, then run migrations.
- Database (apps/web filter): `pnpm db:generate` | `db:migrate-dev` | `db:push` | `db:studio`.
- Never run migrations unless users explicitly asked

## Coding Style & Naming Conventions

- Files: React components PascalCase (e.g., `AppSideBar.tsx`); folders kebab/lowercase.
- Paths (web): use alias `~/` for src imports (e.g., `import { x } from "~/utils/x"`).
- NEVER USE DYNAMIC IMPORTS. ALWAYS IMPORT ON THE TOP

## Rules

- Prefer to use trpc alway unless asked otherwise

## Testing Guidelines

- Web testing is configured with Vitest in `apps/web`; add tests when changes impact logic, APIs, or behavior.
- Prefer targeted suites first: `pnpm test:web:unit`, `pnpm test:web:trpc`, `pnpm test:web:api`; use `pnpm test:web` for default non-integration coverage.
- Test file conventions: `*.unit.test.ts`, `*.trpc.test.ts`, `*.api.test.ts`, `*.integration.test.ts`.
- Integration tests require infra and env (`RUN_INTEGRATION=true` with Postgres/Redis available). Root commands `pnpm test:web:all` and `pnpm test:web:integration:full` auto-manage infra lifecycle.
- Use `pnpm test:infra:up` / `pnpm test:infra:down` when running targeted integration commands manually.
- `pnpm test:web:integration:full` and `test:integration:prepare` run Prisma migrations (`prisma migrate deploy`); never run these unless the user explicitly asks. The one safe path is `test:integration:prepare:local`, which `pnpm test:web:all` uses: its `DATABASE_URL` is hardcoded to the `usesend_test` container that `test:infra:up`/`down` creates and destroys per run, so it cannot reach a dev or production database.
- Test defaults are cloud mode (`NEXT_PUBLIC_IS_CLOUD=true`); keep new tests compatible with cloud behavior unless the task says otherwise.
- Run the tests when you finish a change, before reporting it done. Always `pnpm --filter=web typecheck`, then the suites your change touches; use `pnpm test:web:all` when it touches services, queues, jobs, or the database. Report what you actually ran and what it said — if a suite was skipped or failed, say so rather than describing the change as complete.

## Commit & Pull Request Guidelines

- Prefer Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Git history shows frequent feat/fix usage.
- Track the issue number as the commit scope: `feat(#42): …`, `refactor(#3): …`. Applies to PR titles too, since a squash merge uses the title as the subject. Still put `Closes #nnn` in the body — the scope alone does not close the issue.
- PRs must include: clear description, linked issues, screenshots for UI changes, migration notes, and verification steps.
- never run build,migration commands unless asked for
