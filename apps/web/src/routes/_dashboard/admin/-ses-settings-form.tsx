import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@usesend/ui/src/form";
import { Input } from "@usesend/ui/src/input";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { sesRegionSchema } from "~/lib/zod/ses-setting-schema";
import { adminKeys, adminQueries } from "~/queries/admin";
import { addSesSettings } from "~/server/functions/admin";
import { isLocalhost } from "~/utils/client";

/**
 * Add a sending region, from `components/settings/AddSesSettings.tsx` (#9).
 *
 * It appears in two places and always has: as a dialog on `/admin`, and as the
 * whole screen when the installation has no region at all and cannot send
 * anything yet. That is why it lives beside the admin routes rather than
 * inside one of them.
 *
 * The region field asks SES for that region's quota when it loses focus, and
 * fills the send rate in with the answer. `queryClient.fetchQuery` is the
 * imperative form of the `utils.admin.getQuotaForRegion.fetch()` it replaces,
 * and it caches under `adminKeys.quota(region)`, so tabbing back and forth
 * across the field does not bill a second SES call.
 */
const formSchema = z.object({
  region: sesRegionSchema,
  usesendUrl: z.string().url(),
  sendRate: z.coerce.number(),
  transactionalQuota: z.coerce.number().min(0).max(100),
});

type SesSettingsFormValues = z.infer<typeof formSchema>;

export const SesSettingsForm: React.FC<{ onSuccess?: () => void }> = ({
  onSuccess,
}) => {
  const defaultRegion = useQuery(adminQueries.defaultSesRegion());

  if (defaultRegion.isLoading) {
    return (
      <div className="flex min-h-[500px] items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (!defaultRegion.data) {
    return (
      <div className="flex min-h-[500px] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground" role="alert">
          Failed to load the default AWS region.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void defaultRegion.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <SesSettingsFields
      defaultRegion={defaultRegion.data}
      onSuccess={onSuccess}
    />
  );
};

const SesSettingsFields: React.FC<{
  defaultRegion: string;
  onSuccess?: () => void;
}> = ({ defaultRegion, onSuccess }) => {
  const queryClient = useQueryClient();

  const form = useForm<SesSettingsFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      region: defaultRegion,
      usesendUrl: "",
      sendRate: 1,
      transactionalQuota: 50,
    },
  });

  const add = useMutation({
    mutationFn: addSesSettings,
    onSuccess: async () => {
      // The whole area: the region list feeds the add-domain dialog as well as
      // the table this was submitted from.
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
      onSuccess?.();
    },
    onError: (error) =>
      toast.error("Failed to create", { description: error.message }),
  });

  function onSubmit(values: SesSettingsFormValues) {
    // SES posts its notifications to this URL, so it has to be reachable from
    // the internet — except when the whole thing is running on a laptop.
    if (!isLocalhost()) {
      if (!values.usesendUrl.startsWith("https://")) {
        form.setError("usesendUrl", {
          message: "URL must start with https://",
        });
        return;
      }

      if (values.usesendUrl.includes("localhost")) {
        form.setError("usesendUrl", { message: "URL must be a valid url" });
        return;
      }
    }

    add.mutate({ data: values });
  }

  async function fillSendRateFromSes() {
    const region = sesRegionSchema.safeParse(form.getValues("region"));

    if (!region.success) {
      return;
    }

    form.clearErrors("region");

    try {
      const quota = await queryClient.fetchQuery(
        adminQueries.quota(region.data),
      );
      form.setValue("sendRate", quota ?? 1);
    } catch {
      form.setValue("sendRate", 1);
      form.setError("region", {
        message: "Unable to load the SES quota for this region",
      });
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex min-h-[500px] w-full flex-col gap-8"
      >
        <FormField
          control={form.control}
          name="region"
          render={({ field, formState }) => (
            <FormItem>
              <FormLabel>Region</FormLabel>
              <FormControl>
                <Input
                  placeholder="us-east-1"
                  className="w-full"
                  {...field}
                  onBlur={() => {
                    void fillSendRateFromSes();
                    field.onBlur();
                  }}
                />
              </FormControl>
              {formState.errors.region ? (
                <FormMessage />
              ) : (
                <FormDescription>The region of the SES account</FormDescription>
              )}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="usesendUrl"
          render={({ field, formState }) => (
            <FormItem>
              <FormLabel>Callback URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://example.com"
                  className="w-full"
                  {...field}
                />
              </FormControl>
              {formState.errors.usesendUrl ? (
                <FormMessage />
              ) : (
                <FormDescription>
                  This url should be accessible from the internet. Will be
                  called from SES
                </FormDescription>
              )}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="sendRate"
          render={({ field, formState }) => (
            <FormItem>
              <FormLabel>Send Rate</FormLabel>
              <FormControl>
                <Input placeholder="1" className="w-full" {...field} />
              </FormControl>
              {formState.errors.sendRate ? (
                <FormMessage />
              ) : (
                <FormDescription>
                  The number of emails to send per second.
                </FormDescription>
              )}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="transactionalQuota"
          render={({ field, formState }) => (
            <FormItem>
              <FormLabel>Transactional Quota</FormLabel>
              <FormControl>
                <Input placeholder="0" className="w-full" {...field} />
              </FormControl>
              {formState.errors.transactionalQuota ? (
                <FormMessage />
              ) : (
                <FormDescription>
                  The percentage of the quota to be used for transactional
                  emails (0-100%).
                </FormDescription>
              )}
            </FormItem>
          )}
        />
        <Button
          type="submit"
          disabled={add.isPending}
          className="mx-auto w-[200px]"
        >
          {add.isPending ? <Spinner className="h-5 w-5" /> : "Create"}
        </Button>
      </form>
    </Form>
  );
};

/** The full-screen form shown when nothing has ever been configured. */
export const SesSettingsScreen: React.FC<{ onSuccess?: () => void }> = ({
  onSuccess,
}) => (
  <div className="flex min-h-screen items-center justify-center">
    <div className="flex w-[400px] flex-col gap-8">
      <h1 className="text-center text-2xl font-semibold">Add SES Settings</h1>
      <SesSettingsForm onSuccess={onSuccess} />
    </div>
  </div>
);
