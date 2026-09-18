# Docker in this repository

**useSend's web app is not a container.** It is a Cloudflare Worker, deployed
with `wrangler deploy`, and the `usesend/usesend` image — a Next.js standalone
server started by `docker/start.sh` — is gone along with the Next.js app it ran
(#12). Self-hosting instructions live at
[docs.usesend.com/self-hosting/overview](https://docs.usesend.com/self-hosting/overview).

What is left here is local infrastructure and one shipped image.

## Local development infrastructure

`docker/dev/compose.yml` — started by `pnpm dx:up`, stopped by `pnpm dx:down`.
It runs Neon Local (a proxy to a real Neon branch, not a local Postgres), the
local SES/SNS simulator and MinIO. It reads `NEON_PROJECT_ID`, `NEON_API_KEY`
and `NEON_BRANCH_ID` from the repo-root `.env`; the `dx` scripts pass
`--project-directory .` so compose finds it.

`docker/testing/compose.yml` — started by `pnpm test:infra:up`, stopped by
`pnpm test:infra:down`. One throwaway `postgres:16` on port 54329 holding the
`usesend_test` database that the integration suite and `pnpm dev:worker`
(through the local Hyperdrive binding) run against.

Neither is a shipped artifact. Neither is published anywhere.

## The SMTP proxy image

`apps/smtp-server` keeps its own `Dockerfile` and is the only image this
repository publishes (`usesend/smtp-proxy`, built by
`.github/workflows/publish.yml` on a tag). It is a raw TCP SMTP listener on
:465/:587 and cannot run on Workers, so it stays a container — see
`references/serverless-migration.md` §7. It talks to useSend over the public
HTTP API only, so it can be pointed at any instance, self-hosted or cloud.

Setup is documented under "SMTP Proxy Server" in
[docs.usesend.com/self-hosting/overview](https://docs.usesend.com/self-hosting/overview).
