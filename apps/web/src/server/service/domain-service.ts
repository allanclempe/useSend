import dns from "dns";
import util from "util";
import * as tldts from "tldts";
import * as ses from "~/server/aws/ses";
import { env } from "~/env";
import { renderDomainVerificationStatusEmail } from "~/server/email-templates";
import { logger } from "~/server/logger/log";
import { sendMail } from "~/server/mailer";
import { cacheAdd, cacheDelete, cacheGet, cachePut } from "~/server/cache";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";

type Domain = typeof schema.domain.$inferSelect;
import { SesSettingsService } from "./ses-settings-service";
import { UnsendApiError } from "../public-api/api-error";
import { ApiKey, DomainStatus } from "~/types/db";
import { and, desc, eq } from "drizzle-orm";
import {
  type DomainPayload,
  type DomainWebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";
import { LimitService } from "./limit-service";
import type { DomainDnsRecord } from "~/types/domain";
import { WebhookService } from "./webhook-service";

const DOMAIN_STATUS_VALUES = new Set(Object.values(DomainStatus));
export const DOMAIN_UNVERIFIED_RECHECK_MS = 6 * 60 * 60 * 1000;
export const DOMAIN_VERIFIED_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFIED_DOMAIN_STATUSES = new Set<DomainStatus>([DomainStatus.SUCCESS]);

type DomainVerificationState = {
  hasEverVerified: boolean;
  lastCheckedAt: Date | null;
  lastNotifiedStatus: DomainStatus | null;
};

type DomainWithDnsRecords = Domain & { dnsRecords: DomainDnsRecord[] };

type DomainVerificationRefreshResult = DomainWithDnsRecords & {
  verificationError: string | null;
  lastCheckedTime: string | null;
  previousStatus: DomainStatus;
  statusChanged: boolean;
  hasEverVerified: boolean;
};

function parseDomainStatus(status?: string | null): DomainStatus {
  if (!status) {
    return DomainStatus.NOT_STARTED;
  }

  const normalized = status.toUpperCase();

  if (DOMAIN_STATUS_VALUES.has(normalized as DomainStatus)) {
    return normalized as DomainStatus;
  }

  return DomainStatus.NOT_STARTED;
}

function buildDnsRecords(domain: Domain): DomainDnsRecord[] {
  const subdomainSuffix = domain.subdomain ? `.${domain.subdomain}` : "";
  const mailDomain = `mail${subdomainSuffix}`;
  const dkimSelector = domain.dkimSelector ?? "usesend";

  const spfStatus = parseDomainStatus(domain.spfDetails);
  const dkimStatus = parseDomainStatus(domain.dkimStatus);
  const dmarcStatus = domain.dmarcAdded
    ? DomainStatus.SUCCESS
    : DomainStatus.NOT_STARTED;

  return [
    {
      type: "MX",
      name: mailDomain,
      value: `feedback-smtp.${domain.region}.amazonses.com`,
      ttl: "Auto",
      priority: "10",
      status: spfStatus,
    },
    {
      type: "TXT",
      name: `${dkimSelector}._domainkey${subdomainSuffix}`,
      value: `p=${domain.publicKey}`,
      ttl: "Auto",
      status: dkimStatus,
    },
    {
      type: "TXT",
      name: mailDomain,
      value: "v=spf1 include:amazonses.com ~all",
      ttl: "Auto",
      status: spfStatus,
    },
    {
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=none;",
      ttl: "Auto",
      status: dmarcStatus,
      recommended: true,
    },
  ];
}

function withDnsRecords<T extends Domain>(
  domain: T,
): T & { dnsRecords: DomainDnsRecord[] } {
  return {
    ...domain,
    dnsRecords: buildDnsRecords(domain),
  };
}

const dnsResolveTxt = util.promisify(dns.resolveTxt);

/**
 * Domain verification bookkeeping: what the sweep remembers about a domain
 * between runs.
 *
 * This is the state that blocked domain verification on Workers. It used to be
 * three Redis keys read with `MGET`, and `server/redis.ts` caches its ioredis
 * connection in a module-level `let` — which on Workers serves exactly one
 * invocation and then hangs, because the runtime ties an I/O object to the
 * request that opened it. Measured under `wrangler dev`: page one of the hourly
 * sweep ran, and both its continuation and the next cron stalled.
 *
 * It is now one KV value per domain rather than three keys. Not cosmetic: every
 * binding call is a subrequest against a cap of 1000 per invocation, the page
 * size is 25 domains, and `refreshDomainVerification` already spends several
 * subrequests per domain on SES and DNS. One read and one write instead of
 * three and three is the difference between comfortable headroom and arithmetic.
 *
 * KV's eventual consistency is the right trade here and it is worth saying why:
 * the only reader is an hourly sweep, the recheck intervals are six hours and
 * thirty days, and the value is advisory — losing it re-checks a domain sooner
 * than necessary, which is the harmless direction.
 */
type StoredDomainVerificationState = {
  hasEverVerified?: boolean;
  lastCheckedAt?: string | null;
  lastNotifiedStatus?: string | null;
};

function domainVerificationKey(domainId: number) {
  return `domain:verification:${domainId}`;
}

/**
 * Short-lived guard against sending the same status notification twice.
 *
 * Best-effort on KV — `CacheStore.add` explains why — and that is acceptable
 * precisely here: the sweep is serialised (an hourly cron whose continuation
 * queue runs at `max_concurrency` 1), so there is no concurrency to lose a race
 * against in the first place, and if there were, the cost is one duplicate
 * email. `lastNotifiedStatus` is the durable half of the same guard.
 */
function domainNotificationLockKey(domainId: number, status: DomainStatus) {
  return `domain:verification:notify-lock:${domainId}:${status}`;
}

const DOMAIN_NOTIFICATION_LOCK_TTL_SECONDS = 300;

function normalizeDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getDomainVerificationState(
  domainId: number,
): Promise<DomainVerificationState> {
  const raw = await cacheGet(domainVerificationKey(domainId));

  let stored: StoredDomainVerificationState = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        stored = parsed as StoredDomainVerificationState;
      }
    } catch {
      // A value we cannot read is a value we do not have. The sweep re-checks
      // the domain, which is the safe direction.
    }
  }

  return {
    hasEverVerified: stored.hasEverVerified === true,
    lastCheckedAt: normalizeDate(stored.lastCheckedAt),
    lastNotifiedStatus: DOMAIN_STATUS_VALUES.has(
      (stored.lastNotifiedStatus ?? "") as DomainStatus,
    )
      ? (stored.lastNotifiedStatus as DomainStatus)
      : null,
  };
}

async function putDomainVerificationState(
  domainId: number,
  state: DomainVerificationState,
) {
  await cachePut(
    domainVerificationKey(domainId),
    JSON.stringify({
      hasEverVerified: state.hasEverVerified,
      lastCheckedAt: state.lastCheckedAt?.toISOString() ?? null,
      lastNotifiedStatus: state.lastNotifiedStatus,
    } satisfies StoredDomainVerificationState),
  );
}

async function reserveDomainStatusNotification(
  domainId: number,
  status: DomainStatus,
) {
  return await cacheAdd(domainNotificationLockKey(domainId, status), "1", {
    ttlSeconds: DOMAIN_NOTIFICATION_LOCK_TTL_SECONDS,
  });
}

async function clearDomainVerificationState(domainId: number) {
  await cacheDelete(domainVerificationKey(domainId));
}

function shouldContinueVerifying(
  verificationStatus: DomainStatus,
  dkimStatus: string | undefined,
  spfDetails: string | undefined,
) {
  if (
    verificationStatus === DomainStatus.SUCCESS &&
    dkimStatus === DomainStatus.SUCCESS &&
    spfDetails === DomainStatus.SUCCESS
  ) {
    return false;
  }

  return verificationStatus !== DomainStatus.FAILED;
}

function shouldSendDomainStatusNotification({
  previousStatus,
  currentStatus,
  hasEverVerified,
  lastNotifiedStatus,
}: {
  previousStatus: DomainStatus;
  currentStatus: DomainStatus;
  hasEverVerified: boolean;
  lastNotifiedStatus: DomainStatus | null;
}) {
  if (lastNotifiedStatus === null && currentStatus === previousStatus) {
    return false;
  }

  if (hasEverVerified) {
    return currentStatus !== lastNotifiedStatus;
  }

  if (
    currentStatus !== DomainStatus.SUCCESS &&
    currentStatus !== DomainStatus.FAILED
  ) {
    return false;
  }

  return currentStatus !== lastNotifiedStatus;
}

async function sendDomainStatusNotification({
  domain,
  previousStatus,
}: {
  domain: Domain;
  previousStatus: DomainStatus;
}) {
  const recipients = (
    await drizzleDb
      .select({ email: schema.user.email })
      .from(schema.teamUser)
      .innerJoin(schema.user, eq(schema.user.id, schema.teamUser.userId))
      .where(eq(schema.teamUser.teamId, domain.teamId))
  )
    .map((row) => row.email)
    .filter((email): email is string => Boolean(email));

  if (recipients.length === 0) {
    logger.info(
      { domainId: domain.id, teamId: domain.teamId },
      "[DomainService]: Skipping domain status email because team has no recipients",
    );
    return;
  }

  const subject =
    domain.status === DomainStatus.SUCCESS
      ? `useSend: ${domain.name} is verified`
      : previousStatus === DomainStatus.SUCCESS
        ? `useSend: ${domain.name} verification status changed`
        : `useSend: ${domain.name} verification failed`;

  const domainUrl = `${env.APP_URL}/domains/${domain.id}`;
  const html = await renderDomainVerificationStatusEmail({
    domainName: domain.name,
    currentStatus: domain.status,
    previousStatus,
    domainUrl,
  });
  const statusMessage =
    domain.status === DomainStatus.SUCCESS
      ? `Your domain ${domain.name} is now verified, and you can start sending emails.`
      : `Your domain ${domain.name} could not be verified because the DNS records are not set up correctly yet. Please review your DNS settings and try again.`;
  const textLines = [
    "Hey,",
    null,
    statusMessage,
    null,
    `Open domain settings: ${domainUrl}`,
    null,
    "Thanks,",
    "useSend Team",
  ].filter((value): value is string => Boolean(value));

  await Promise.all(
    recipients.map((email) =>
      sendMail(email, subject, textLines.join("\n"), html, "hey@usesend.com"),
    ),
  );
}

function buildDomainPayload(domain: Domain): DomainPayload {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    region: domain.region,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
    clickTracking: domain.clickTracking,
    openTracking: domain.openTracking,
    subdomain: domain.subdomain,
    sesTenantId: domain.sesTenantId,
    dkimStatus: domain.dkimStatus,
    spfDetails: domain.spfDetails,
    dmarcAdded: domain.dmarcAdded,
  };
}

export async function validateDomainFromEmail(email: string, teamId: number) {
  // Extract email from format like 'Name <email@domain>' this will allow entries such as "Someone @ something <some@domain.com>" to parse correctly as well.
  const match = email.match(/<([^>]+)>/);
  let fromDomain: string | undefined;

  if (match && match[1]) {
    const parts = match[1].split("@");
    fromDomain = parts.length > 1 ? parts[1] : undefined;
  } else {
    const parts = email.split("@");
    fromDomain = parts.length > 1 ? parts[1] : undefined;
  }

  if (fromDomain?.endsWith(">")) {
    fromDomain = fromDomain.slice(0, -1);
  }

  if (!fromDomain) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "From email is invalid",
    });
  }

  const [domain] = await drizzleDb
    .select()
    .from(schema.domain)
    .where(
      and(
        eq(schema.domain.name, fromDomain),
        eq(schema.domain.teamId, teamId),
      ),
    )
    .limit(1);

  if (!domain) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Domain: ${fromDomain} of from email is wrong. Use the domain verified by useSend`,
    });
  }

  if (domain.status !== "SUCCESS") {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Domain: ${fromDomain} is not verified`,
    });
  }

  return domain;
}

export async function validateApiKeyDomainAccess(
  email: string,
  teamId: number,
  apiKey: ApiKey & { domain?: { name: string } | null },
) {
  // First validate the domain exists and is verified
  const domain = await validateDomainFromEmail(email, teamId);

  // If API key has no domain restriction (domainId is null), allow all domains
  if (!apiKey.domainId) {
    return domain;
  }

  // If API key is restricted to a specific domain, check if it matches
  if (apiKey.domainId !== domain.id) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: `API key does not have access to domain: ${domain.name}`,
    });
  }

  return domain;
}

export async function createDomain(
  teamId: number,
  name: string,
  region: string,
  sesTenantId?: string,
) {
  const domainStr = tldts.getDomain(name);

  logger.info({ domainStr, name, region }, "Creating domain");

  if (!domainStr) {
    throw new Error("Invalid domain");
  }

  const setting = await SesSettingsService.getSetting(region);

  if (!setting) {
    throw new Error("Ses setting not found");
  }

  const { isLimitReached, reason } =
    await LimitService.checkDomainLimit(teamId);

  if (isLimitReached) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: reason ?? "Domain limit reached",
    });
  }

  const subdomain = tldts.getSubdomain(name);
  const dkimSelector = "usesend";
  const publicKey = await ses.addDomain(
    name,
    region,
    sesTenantId,
    dkimSelector,
  );

  const [domain] = await drizzleDb
    .insert(schema.domain)
    .values(
      withUpdatedAt({
        name,
        publicKey,
        teamId,
        subdomain,
        region,
        sesTenantId,
        dkimSelector,
        dkimStatus: DomainStatus.NOT_STARTED,
        spfDetails: DomainStatus.NOT_STARTED,
      }),
    )
    .returning();

  if (!domain) {
    throw new UnsendApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create domain",
    });
  }

  await emitDomainEvent(domain, "domain.created");

  return withDnsRecords(domain);
}

export async function getDomain(id: number, teamId: number) {
  const [domain] = await drizzleDb
    .select()
    .from(schema.domain)
    .where(and(eq(schema.domain.id, id), eq(schema.domain.teamId, teamId)))
    .limit(1);

  if (!domain) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Domain not found",
    });
  }

  if (domain.isVerifying) {
    return refreshDomainVerification(domain);
  }

  return withDnsRecords(domain);
}

export async function refreshDomainVerification(
  domainOrId: number | Domain,
): Promise<DomainVerificationRefreshResult> {
  const domain =
    typeof domainOrId === "number"
      ? (
          await drizzleDb
            .select()
            .from(schema.domain)
            .where(eq(schema.domain.id, domainOrId))
            .limit(1)
        )[0]
      : domainOrId;

  if (!domain) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Domain not found",
    });
  }

  const verificationState = await getDomainVerificationState(domain.id);
  const previousStatus = domain.status;
  const domainIdentity = await ses.getDomainIdentity(
    domain.name,
    domain.region,
  );
  const dkimStatus = domainIdentity.DkimAttributes?.Status?.toString();
  const spfDetails =
    domainIdentity.MailFromAttributes?.MailFromDomainStatus?.toString();
  const verificationError =
    domainIdentity.VerificationInfo?.ErrorType?.toString() ?? null;
  const verificationStatus = parseDomainStatus(
    domainIdentity.VerificationStatus?.toString(),
  );
  const lastCheckedTime = domainIdentity.VerificationInfo?.LastCheckedTimestamp;
  const baseDomain = tldts.getDomain(domain.name);
  const _dmarcRecord = baseDomain ? await getDmarcRecord(baseDomain) : null;
  const dmarcRecord = _dmarcRecord?.[0]?.[0];
  const checkedAt = new Date();

  const [updatedDomain] = await drizzleDb
    .update(schema.domain)
    .set(
      withUpdatedAt({
        dkimStatus: dkimStatus ?? null,
        spfDetails: spfDetails ?? null,
        status: verificationStatus,
        errorMessage: verificationError,
        dmarcAdded: Boolean(dmarcRecord),
        isVerifying: shouldContinueVerifying(
          verificationStatus,
          dkimStatus,
          spfDetails,
        ),
      }),
    )
    .where(eq(schema.domain.id, domain.id))
    .returning();

  if (!updatedDomain) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Domain not found",
    });
  }

  // One write where there used to be two, because the state is one value now.
  // `hasEverVerified` latches: a domain that has verified once is never
  // un-verified, which is what makes the recheck interval thirty days.
  const nextState: DomainVerificationState = {
    hasEverVerified:
      verificationState.hasEverVerified ||
      updatedDomain.status === DomainStatus.SUCCESS,
    lastCheckedAt: checkedAt,
    lastNotifiedStatus: verificationState.lastNotifiedStatus,
  };

  await putDomainVerificationState(domain.id, nextState);

  if (
    shouldSendDomainStatusNotification({
      previousStatus,
      currentStatus: updatedDomain.status,
      hasEverVerified: nextState.hasEverVerified,
      lastNotifiedStatus: verificationState.lastNotifiedStatus,
    })
  ) {
    const reservedNotification = await reserveDomainStatusNotification(
      domain.id,
      updatedDomain.status,
    );

    if (reservedNotification) {
      try {
        await sendDomainStatusNotification({
          domain: updatedDomain,
          previousStatus,
        });
        await putDomainVerificationState(domain.id, {
          ...nextState,
          lastNotifiedStatus: updatedDomain.status,
        });
      } catch (error) {
        logger.error(
          { err: error, domainId: domain.id, status: updatedDomain.status },
          "[DomainService]: Failed to send domain status notification",
        );
      }
    }
  }

  const normalizedDomain = {
    ...updatedDomain,
    dkimStatus: dkimStatus ?? null,
    spfDetails: spfDetails ?? null,
    dmarcAdded: Boolean(dmarcRecord),
  } satisfies Domain;

  const domainWithDns = withDnsRecords(normalizedDomain);
  const normalizedLastCheckedTime =
    lastCheckedTime instanceof Date
      ? lastCheckedTime.toISOString()
      : lastCheckedTime != null
        ? String(lastCheckedTime)
        : null;

  if (previousStatus !== domainWithDns.status) {
    const eventType: DomainWebhookEventType =
      domainWithDns.status === DomainStatus.SUCCESS
        ? "domain.verified"
        : "domain.updated";
    await emitDomainEvent(domainWithDns, eventType);
  }

  return {
    ...domainWithDns,
    dkimStatus: normalizedDomain.dkimStatus,
    spfDetails: normalizedDomain.spfDetails,
    verificationError,
    lastCheckedTime: normalizedLastCheckedTime,
    dmarcAdded: normalizedDomain.dmarcAdded,
    previousStatus,
    statusChanged: previousStatus !== domainWithDns.status,
    hasEverVerified:
      verificationState.hasEverVerified ||
      domainWithDns.status === DomainStatus.SUCCESS,
  };
}

export async function updateDomain(
  id: number,
  data: { clickTracking?: boolean; openTracking?: boolean },
) {
  const [updated] = await drizzleDb
    .update(schema.domain)
    .set(withUpdatedAt(data))
    .where(eq(schema.domain.id, id))
    .returning();

  if (!updated) {
    throw new Error("Domain not found");
  }

  await emitDomainEvent(updated, "domain.updated");

  return updated;
}

export async function deleteDomain(id: number) {
  const [domain] = await drizzleDb
    .select()
    .from(schema.domain)
    .where(eq(schema.domain.id, id))
    .limit(1);

  if (!domain) {
    throw new Error("Domain not found");
  }

  const deleted = await ses.deleteDomain(
    domain.name,
    domain.region,
    domain.sesTenantId ?? undefined,
  );

  if (!deleted) {
    throw new Error("Error in deleting domain");
  }

  const [deletedRecord] = await drizzleDb
    .delete(schema.domain)
    .where(eq(schema.domain.id, id))
    .returning();

  if (!deletedRecord) {
    throw new Error("Domain not found");
  }
  try {
    await clearDomainVerificationState(id);
  } catch (error) {
    logger.error(
      { err: error, domainId: id },
      "[DomainService]: Failed to clear domain verification state",
    );
  }

  await emitDomainEvent(domain, "domain.deleted");

  return deletedRecord;
}

export async function getDomains(
  teamId: number,
  options?: { domainId?: number },
) {
  const domains = await drizzleDb
    .select()
    .from(schema.domain)
    .where(
      and(
        eq(schema.domain.teamId, teamId),
        options?.domainId ? eq(schema.domain.id, options.domainId) : undefined,
      ),
    )
    .orderBy(desc(schema.domain.createdAt));

  return domains.map((d) => withDnsRecords(d));
}

async function getDmarcRecord(domain: string) {
  try {
    const dmarcRecord = await dnsResolveTxt(`_dmarc.${domain}`);
    return dmarcRecord;
  } catch (error) {
    logger.error({ err: error, domain }, "Error fetching DMARC record");
    return null; // or handle error as appropriate
  }
}

async function emitDomainEvent(domain: Domain, type: DomainWebhookEventType) {
  try {
    await WebhookService.emit(domain.teamId, type, buildDomainPayload(domain), {
      domainId: domain.id,
    });
  } catch (error) {
    logger.error(
      { error, domainId: domain.id, type },
      "[DomainService]: Failed to emit domain webhook event",
    );
  }
}

export async function isDomainVerificationDue(domain: Domain) {
  const verificationState = await getDomainVerificationState(domain.id);

  if (
    !verificationState.hasEverVerified &&
    domain.status === DomainStatus.FAILED &&
    !domain.isVerifying
  ) {
    return false;
  }

  const now = Date.now();
  const lastCheckedAt = verificationState.lastCheckedAt?.getTime() ?? 0;
  const intervalMs =
    verificationState.hasEverVerified ||
    VERIFIED_DOMAIN_STATUSES.has(domain.status)
      ? DOMAIN_VERIFIED_RECHECK_MS
      : DOMAIN_UNVERIFIED_RECHECK_MS;

  if (!verificationState.lastCheckedAt) {
    return true;
  }

  return now - lastCheckedAt >= intervalMs;
}
