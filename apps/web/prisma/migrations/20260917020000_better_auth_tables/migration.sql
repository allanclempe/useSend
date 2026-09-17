-- Replaces the NextAuth v4 auth tables with better-auth's (issue #8).
--
-- The NextAuth tables are dropped and recreated rather than migrated column by
-- column. The original plan mapped better-auth's fields onto the existing
-- column names (`sessionToken`, `providerAccountId`, `expires`, ...) so that
-- existing rows stayed readable; that was abandoned once the owner confirmed
-- there is no production data to preserve. A clean schema beats a compatible
-- one, and the mapping it removes was roughly forty lines of adapter config.
--
-- Two shape changes worth naming:
--
--   * `Session.id` and `Account.id` go from `TEXT` (Prisma cuid, generated
--     client-side) to `SERIAL`. This is forced, not cosmetic: better-auth's
--     `generateId: "serial"` omits `id` from inserts and coerces it with
--     `Number()` on lookup, so a cuid primary key reads back as NaN and every
--     find-by-id silently misses.
--   * `User.emailVerified` goes from `TIMESTAMP(3)` to `BOOLEAN`. better-auth
--     declares it boolean and there is no configuration that reconciles the two.
--
-- NOTE FOR THE OPERATOR: everyone is signed out by this migration. The session
-- rows are discarded, and even had they been kept, a NextAuth cookie is not a
-- valid better-auth cookie -- different name, and better-auth signs the value.
-- There is no configuration that bridges them.
--
-- NOTE FOR THE OPERATOR: `User.email` becomes NOT NULL with no backfill, because
-- an address cannot be invented. If any row has a NULL email this migration
-- stops here rather than guessing -- decide what those rows are and deal with
-- them first. `User.name` does get a backfill: better-auth itself writes
-- `name: name || ""` when a provider supplies none, so "" is its own convention
-- rather than ours.

-- DropTable
DROP TABLE "Account";
DROP TABLE "Session";
DROP TABLE "VerificationToken";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "emailVerified";
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "User" SET "name" = '' WHERE "name" IS NULL;

ALTER TABLE "User" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;

-- CreateTable
CREATE TABLE "Account" (
    "id" SERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" SERIAL NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
