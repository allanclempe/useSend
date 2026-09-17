import { createServerFn } from "@tanstack/react-start";

import { instanceAdminMiddleware } from "~/server/functions/middleware";
import { SesSettingsService } from "~/server/service/ses-settings-service";

/**
 * `server/api/routers/admin.ts`, as server functions (#9).
 *
 * Only `getSesSettings` so far, because the dashboard cannot boot without it:
 * `DashboardProvider` asks whether SES has ever been configured, and shows the
 * set-up screen instead of the app when it has not. The rest of the admin area
 * follows with its own routes.
 */
export const getSesSettings = createServerFn({ method: "GET" })
  .middleware([instanceAdminMiddleware])
  .handler(() => SesSettingsService.getAllSettings());
