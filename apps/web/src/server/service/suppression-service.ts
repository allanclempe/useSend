import { SuppressionReason, SuppressionList } from "@prisma/client";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { UnsendApiError } from "~/server/public-api/api-error";
import { logger } from "../logger/log";
import { deleteFromSesSuppressionList } from "../aws/ses";

export type AddSuppressionParams = {
  email: string;
  teamId: number;
  reason: SuppressionReason;
  source?: string;
};

export type GetSuppressionListParams = {
  teamId: number;
  page?: number;
  limit?: number;
  search?: string;
  reason?: SuppressionReason | null;
  sortBy?: "email" | "reason" | "createdAt";
  sortOrder?: "asc" | "desc";
};

export type SuppressionListResult = {
  suppressions: SuppressionList[];
  total: number;
};

export class SuppressionService {
  /**
   * Add email to suppression list
   */
  static async addSuppression(
    params: AddSuppressionParams
  ): Promise<SuppressionList> {
    const { email, teamId, reason, source } = params;

    try {
      const [suppression] = await drizzleDb
        .insert(schema.suppressionList)
        .values(
          withUpdatedAt({
            id: createId(),
            email: email.toLowerCase().trim(),
            teamId,
            reason,
            source,
          }),
        )
        .onConflictDoUpdate({
          target: [
            schema.suppressionList.teamId,
            schema.suppressionList.email,
          ],
          set: withUpdatedAt({ reason, source }),
        })
        .returning();

      if (!suppression) {
        throw new Error("Failed to upsert suppression");
      }

      logger.info(
        {
          email,
          teamId,
          reason,
          source,
          suppressionId: suppression.id,
        },
        "Email added to suppression list"
      );

      return suppression;
    } catch (error) {
      logger.error(
        {
          email,
          teamId,
          reason,
          source,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to add email to suppression list"
      );

      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to add email to suppression list",
      });
    }
  }

  /**
   * Check if email is suppressed for team
   */
  static async isEmailSuppressed(
    email: string,
    teamId: number
  ): Promise<boolean> {
    try {
      const [suppression] = await drizzleDb
        .select({ id: schema.suppressionList.id })
        .from(schema.suppressionList)
        .where(
          and(
            eq(schema.suppressionList.teamId, teamId),
            eq(schema.suppressionList.email, email.toLowerCase().trim()),
          ),
        )
        .limit(1);

      return !!suppression;
    } catch (error) {
      logger.error(
        {
          email,
          teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to check email suppression status"
      );

      // In case of error, err on the side of caution and don't suppress
      return false;
    }
  }

  /**
   * Remove email from suppression list (both local DB and AWS SES)
   */
  static async removeSuppression(email: string, teamId: number): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();

    // Get all unique regions from team's domains for AWS SES cleanup
    try {
      const teamDomains = await drizzleDb
        .select({ region: schema.domain.region })
        .from(schema.domain)
        .where(eq(schema.domain.teamId, teamId));
      const uniqueRegions = [...new Set(teamDomains.map((d) => d.region))];

      // Attempt to remove from AWS SES in all regions (best effort, don't throw)
      if (uniqueRegions.length > 0) {
        const results = await Promise.allSettled(
          uniqueRegions.map((region) =>
            deleteFromSesSuppressionList(normalizedEmail, region)
          )
        );

        // Check for failures - deleteFromSesSuppressionList returns false on error
        const failures = results.filter(
          (r) =>
            r.status === "rejected" ||
            (r.status === "fulfilled" && r.value === false)
        );
        if (failures.length > 0) {
          logger.warn(
            {
              email: normalizedEmail,
              teamId,
              failedRegions: failures.length,
              totalRegions: uniqueRegions.length,
            },
            "Some AWS SES regions failed during suppression removal"
          );
        }
      }
    } catch (error) {
      // AWS SES cleanup failure should not block local DB deletion
      logger.error(
        {
          email: normalizedEmail,
          teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to cleanup AWS SES suppression (continuing with local deletion)"
      );
    }

    // Delete from local database
    try {
      const [deleted] = await drizzleDb
        .delete(schema.suppressionList)
        .where(
          and(
            eq(schema.suppressionList.teamId, teamId),
            eq(schema.suppressionList.email, normalizedEmail),
          ),
        )
        .returning();

      // No row matched: it's already not suppressed, which is what the caller
      // wanted. Removing twice, or removing an address that is in SES's
      // suppression list but not ours, must not be an error.
      if (!deleted) {
        logger.debug(
          {
            email: normalizedEmail,
            teamId,
          },
          "Attempted to remove non-existent suppression - already not suppressed"
        );
        return;
      }

      logger.info(
        {
          email: normalizedEmail,
          teamId,
          suppressionId: deleted.id,
        },
        "Email removed from suppression list"
      );
    } catch (error) {
      logger.error(
        {
          email: normalizedEmail,
          teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to remove email from suppression list"
      );

      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to remove email from suppression list",
      });
    }
  }

  /**
   * Get suppression list for team with pagination
   */
  static async getSuppressionList(
    params: GetSuppressionListParams
  ): Promise<SuppressionListResult> {
    const {
      teamId,
      page = 1,
      limit = 20,
      search,
      reason,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = params;

    const offset = (page - 1) * limit;

    const where = and(
      eq(schema.suppressionList.teamId, teamId),
      search ? ilike(schema.suppressionList.email, `%${search}%`) : undefined,
      reason ? eq(schema.suppressionList.reason, reason) : undefined,
    );

    // The sort column is chosen at runtime, so it is looked up rather than named.
    const sortColumns = {
      email: schema.suppressionList.email,
      reason: schema.suppressionList.reason,
      createdAt: schema.suppressionList.createdAt,
    } as const;
    const sortColumn = sortColumns[sortBy] ?? schema.suppressionList.createdAt;

    try {
      const [suppressions, total] = await Promise.all([
        drizzleDb
          .select()
          .from(schema.suppressionList)
          .where(where)
          .orderBy(sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn))
          .offset(offset)
          .limit(limit),
        drizzleDb.$count(schema.suppressionList, where),
      ]);

      return {
        suppressions,
        total,
      };
    } catch (error) {
      logger.error(
        {
          teamId,
          page,
          limit,
          search,
          reason,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get suppression list"
      );

      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to get suppression list",
      });
    }
  }

  /**
   * Add multiple emails to suppression list
   */
  static async addMultipleSuppressions(
    teamId: number,
    emails: string[],
    reason: SuppressionReason
  ) {
    // Remove duplicates by normalizing emails first, then using Set
    const normalizedEmails = emails.map((email) => email.toLowerCase().trim());
    const uniqueEmails = Array.from(new Set(normalizedEmails));

    try {
      // Process in batches to avoid overwhelming the database
      const batchSize = 1000;
      for (let i = 0; i < uniqueEmails.length; i += batchSize) {
        const batch = uniqueEmails.slice(i, i + batchSize);

        const alreadySuppressed = await drizzleDb
          .select({ email: schema.suppressionList.email })
          .from(schema.suppressionList)
          .where(
            and(
              eq(schema.suppressionList.teamId, teamId),
              inArray(schema.suppressionList.email, batch),
            ),
          );

        const emailsToAdd = batch.filter(
          (email) => !alreadySuppressed.some((s) => s.email === email)
        );

        if (emailsToAdd.length > 0) {
          // Drizzle rejects an empty values list, where createMany accepted one.
          await drizzleDb.insert(schema.suppressionList).values(
            emailsToAdd.map((email) =>
              withUpdatedAt({ id: createId(), teamId, email, reason }),
            ),
          );
        }
      }

      logger.info(
        {
          originalCount: emails.length,
          uniqueCount: uniqueEmails.length,
        },
        "Added multiple emails to suppression list"
      );
    } catch (error) {
      logger.error(
        {
          originalCount: emails.length,
          uniqueCount: uniqueEmails.length,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to add multiple emails to suppression list"
      );

      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to add multiple emails to suppression list",
      });
    }
  }

  /**
   * Get suppression statistics for a team
   */
  static async getSuppressionStats(
    teamId: number
  ): Promise<Record<SuppressionReason, number>> {
    try {
      const stats = await drizzleDb
        .select({
          reason: schema.suppressionList.reason,
          // COUNT returns bigint, which postgres-js hands back as a string.
          count: sql<number>`COUNT(*)::integer`,
        })
        .from(schema.suppressionList)
        .where(eq(schema.suppressionList.teamId, teamId))
        .groupBy(schema.suppressionList.reason);

      const result: Record<SuppressionReason, number> = {
        HARD_BOUNCE: 0,
        COMPLAINT: 0,
        MANUAL: 0,
      };

      stats.forEach((stat) => {
        result[stat.reason] = stat.count;
      });

      return result;
    } catch (error) {
      logger.error(
        {
          teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get suppression stats"
      );

      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to get suppression stats",
      });
    }
  }

  /**
   * Check multiple emails for suppression status
   */
  static async checkMultipleEmails(
    emails: string[],
    teamId: number
  ): Promise<Record<string, boolean>> {
    try {
      const normalizedEmails = emails.map((email) =>
        email.toLowerCase().trim()
      );

      const suppressions = await drizzleDb
        .select({ email: schema.suppressionList.email })
        .from(schema.suppressionList)
        .where(
          and(
            eq(schema.suppressionList.teamId, teamId),
            inArray(schema.suppressionList.email, normalizedEmails),
          ),
        );

      const suppressedEmails = new Set(suppressions.map((s) => s.email));

      const result: Record<string, boolean> = {};
      emails.forEach((email) => {
        result[email] = suppressedEmails.has(email.toLowerCase().trim());
      });

      return result;
    } catch (error) {
      logger.error(
        {
          emailCount: emails.length,
          teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to check multiple emails for suppression"
      );

      // In case of error, err on the side of caution and don't suppress any
      const result: Record<string, boolean> = {};
      emails.forEach((email) => {
        result[email] = false;
      });

      return result;
    }
  }
}
