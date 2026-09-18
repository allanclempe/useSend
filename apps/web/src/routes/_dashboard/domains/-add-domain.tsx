import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as tldts from "tldts";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usesend/ui/src/select";
import { toast } from "@usesend/ui/src/toaster";

import { LimitReason } from "~/lib/constants/plans";
import { domainKeys, domainQueries } from "~/queries/domain";
import { limitKeys, limitQueries } from "~/queries/limits";
import { createDomain } from "~/server/functions/domain";
import { useUpgradeModalStore } from "~/store/upgradeModalStore";

const domainSchema = z.object({
  region: z.string().optional(),
  domain: z.string({ required_error: "Domain is required" }).min(1, {
    message: "Domain is required",
  }),
});

export default function AddDomain() {
  const [open, setOpen] = useState(false);

  const regionQuery = useQuery(domainQueries.regions());
  const limitsQuery = useQuery(limitQueries.detail(LimitReason.DOMAIN));

  const { openModal } = useUpgradeModalStore((s) => s.action);

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const addDomain = useMutation({
    mutationFn: createDomain,
    onSuccess: async (domain) => {
      await queryClient.invalidateQueries({ queryKey: domainKeys.all });
      // The new domain counts against the plan, so the next dialog must not be
      // told the old answer.
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      setOpen(false);
      await navigate({
        to: "/domains/$domainId",
        params: { domainId: String(domain.id) },
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const domainForm = useForm<z.infer<typeof domainSchema>>({
    resolver: zodResolver(domainSchema),
    defaultValues: { region: "", domain: "" },
  });

  const singleRegion =
    regionQuery.data?.length === 1 ? regionQuery.data[0] : undefined;

  const showRegionSelect = (regionQuery.data?.length ?? 0) > 1;

  function onDomainAdd(values: z.infer<typeof domainSchema>) {
    const domain = tldts.getDomain(values.domain);

    if (!domain) {
      domainForm.setError("domain", { message: "Invalid domain" });
      return;
    }

    if (!values.region && !singleRegion) {
      domainForm.setError("region", { message: "Region is required" });
      return;
    }

    if (limitsQuery.data?.isLimitReached) {
      openModal(limitsQuery.data.reason);
      return;
    }

    addDomain.mutate({
      data: {
        name: values.domain,
        region: singleRegion ?? values.region ?? "",
      },
    });
  }

  function onOpenChange(nextOpen: boolean) {
    if (nextOpen && limitsQuery.data?.isLimitReached) {
      openModal(limitsQuery.data.reason);
      return;
    }

    setOpen(nextOpen);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? onOpenChange(next) : null)}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" />
          Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a new domain</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...domainForm}>
            <form
              onSubmit={domainForm.handleSubmit(onDomainAdd)}
              className="space-y-8"
            >
              <FormField
                control={domainForm.control}
                name="domain"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Domain</FormLabel>
                    <FormControl>
                      <Input placeholder="subdomain.example.com" {...field} />
                    </FormControl>
                    {formState.errors.domain ? (
                      <FormMessage />
                    ) : (
                      <FormDescription>
                        Use subdomains to separate transactional and marketing
                        emails.{" "}
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />

              {showRegionSelect && (
                <FormField
                  control={domainForm.control}
                  name="region"
                  render={({ field, formState }) => (
                    <FormItem>
                      <FormLabel>Region</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={regionQuery.isLoading}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select region" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {regionQuery.data?.map((region) => (
                            <SelectItem value={region} key={region}>
                              {region}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {formState.errors.region ? (
                        <FormMessage />
                      ) : (
                        <FormDescription>
                          Select the region from where the email is sent{" "}
                        </FormDescription>
                      )}
                    </FormItem>
                  )}
                />
              )}

              <div className="flex justify-end">
                <Button
                  className="w-[100px]"
                  type="submit"
                  disabled={addDomain.isPending || limitsQuery.isLoading}
                >
                  {addDomain.isPending ? "Adding..." : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
