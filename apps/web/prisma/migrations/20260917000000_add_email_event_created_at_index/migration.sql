-- `EmailEvent` is the largest table in the schema and the retention job filters
-- it by `createdAt` alone; without this index every run is a sequential scan.
--
-- NOTE FOR THE OPERATOR: on an existing install `CREATE INDEX` takes a SHARE
-- lock and blocks writes to `EmailEvent` for the duration. On a large table,
-- build it out of band first with
--   CREATE INDEX CONCURRENTLY "EmailEvent_createdAt_idx" ON "EmailEvent"("createdAt");
-- and then apply this migration -- `IF NOT EXISTS` makes that a no-op.
CREATE INDEX IF NOT EXISTS "EmailEvent_createdAt_idx" ON "EmailEvent"("createdAt");
