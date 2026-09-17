-- Prisma declares every scalar list (`String[]`, `Int[]`) as non-nullable, but
-- it only emits `NOT NULL DEFAULT ARRAY[]` for the ones carrying `@default([])`.
-- The rest were created as plain nullable columns, so an insert that omits the
-- field stores SQL NULL. Prisma's client hid that by reading NULL back as `[]`;
-- Drizzle reports what is actually stored, which is how the drift surfaced.
--
-- Bring the columns in line with what both schemas already claim: default to an
-- empty array, backfill the NULLs that got in, then enforce NOT NULL.
--
-- `Webhook.domainIds` is the odd one out -- it already carries the default but
-- was created without NOT NULL, so it needs only the backfill and the constraint.
--
-- NOTE FOR THE OPERATOR: each `SET NOT NULL` takes an ACCESS EXCLUSIVE lock and
-- scans the table to verify the constraint. `Email` is the large one on an
-- established install; run this in a maintenance window, or add the constraint
-- out of band first as a `NOT VALID` CHECK, `VALIDATE` it, and then apply this
-- migration -- Postgres 12+ uses the validated CHECK to skip the scan.

-- AlterTable
ALTER TABLE "Email" ALTER COLUMN "to" SET DEFAULT ARRAY[]::TEXT[],
                    ALTER COLUMN "replyTo" SET DEFAULT ARRAY[]::TEXT[],
                    ALTER COLUMN "cc" SET DEFAULT ARRAY[]::TEXT[],
                    ALTER COLUMN "bcc" SET DEFAULT ARRAY[]::TEXT[];

UPDATE "Email" SET "to" = ARRAY[]::TEXT[] WHERE "to" IS NULL;
UPDATE "Email" SET "replyTo" = ARRAY[]::TEXT[] WHERE "replyTo" IS NULL;
UPDATE "Email" SET "cc" = ARRAY[]::TEXT[] WHERE "cc" IS NULL;
UPDATE "Email" SET "bcc" = ARRAY[]::TEXT[] WHERE "bcc" IS NULL;

ALTER TABLE "Email" ALTER COLUMN "to" SET NOT NULL,
                    ALTER COLUMN "replyTo" SET NOT NULL,
                    ALTER COLUMN "cc" SET NOT NULL,
                    ALTER COLUMN "bcc" SET NOT NULL;

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "cc" SET DEFAULT ARRAY[]::TEXT[],
                       ALTER COLUMN "bcc" SET DEFAULT ARRAY[]::TEXT[],
                       ALTER COLUMN "replyTo" SET DEFAULT ARRAY[]::TEXT[];

UPDATE "Campaign" SET "cc" = ARRAY[]::TEXT[] WHERE "cc" IS NULL;
UPDATE "Campaign" SET "bcc" = ARRAY[]::TEXT[] WHERE "bcc" IS NULL;
UPDATE "Campaign" SET "replyTo" = ARRAY[]::TEXT[] WHERE "replyTo" IS NULL;

ALTER TABLE "Campaign" ALTER COLUMN "cc" SET NOT NULL,
                       ALTER COLUMN "bcc" SET NOT NULL,
                       ALTER COLUMN "replyTo" SET NOT NULL;

-- AlterTable
ALTER TABLE "Webhook" ALTER COLUMN "eventTypes" SET DEFAULT ARRAY[]::TEXT[];

UPDATE "Webhook" SET "eventTypes" = ARRAY[]::TEXT[] WHERE "eventTypes" IS NULL;
UPDATE "Webhook" SET "domainIds" = ARRAY[]::INTEGER[] WHERE "domainIds" IS NULL;

ALTER TABLE "Webhook" ALTER COLUMN "eventTypes" SET NOT NULL,
                      ALTER COLUMN "domainIds" SET NOT NULL;

-- AlterTable
ALTER TABLE "Subscription" ALTER COLUMN "priceIds" SET DEFAULT ARRAY[]::TEXT[];

UPDATE "Subscription" SET "priceIds" = ARRAY[]::TEXT[] WHERE "priceIds" IS NULL;

ALTER TABLE "Subscription" ALTER COLUMN "priceIds" SET NOT NULL;
