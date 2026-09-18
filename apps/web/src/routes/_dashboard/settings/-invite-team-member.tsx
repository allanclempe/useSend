import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
} from "@usesend/ui/src/select";
import { toast } from "@usesend/ui/src/toaster";

import { LimitReason } from "~/lib/constants/plans";
import { domainQueries } from "~/queries/domain";
import { limitKeys, limitQueries } from "~/queries/limits";
import { teamKeys } from "~/queries/team";
import { createTeamInvite } from "~/server/functions/team";
import { useUpgradeModalStore } from "~/store/upgradeModalStore";
import { isCloud, isSelfHosted } from "~/utils/common";
import { useTeam } from "../-team-context";

const inviteSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email("Invalid email address"),
  role: z.enum(["ADMIN", "MEMBER"], {
    required_error: "Please select a role",
  }),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

/**
 * Invite someone to the team, by email or — self-hosted — by a link.
 *
 * "Send" and "Copy link" are the same mutation with `sendEmail` flipped, and
 * which buttons show follows from whether mail can go out at all: a
 * self-hosted installation with no verified domain has no `hello@…` to send
 * from, so the link is the only route and the Send button is hidden.
 *
 * A pending invite counts against the plan's member limit, so this is one of
 * the four places that can open the upgrade modal, and both paths invalidate
 * `limitKeys.all` on success — the next dialog must not be told the old
 * answer.
 */
export default function InviteTeamMember() {
  const { currentIsAdmin } = useTeam();
  const [open, setOpen] = useState(false);

  const domainsQuery = useQuery(domainQueries.list());
  const limitsQuery = useQuery(limitQueries.detail(LimitReason.TEAM_MEMBER));
  const { openModal } = useUpgradeModalStore((s) => s.action);

  const queryClient = useQueryClient();

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "MEMBER" },
  });

  const invite = useMutation({
    mutationFn: createTeamInvite,
    onError: (error) => toast.error(error.message),
  });

  /** True when the limit stopped us and the upgrade modal was opened instead. */
  function blockedByLimit() {
    if (!limitsQuery.data?.isLimitReached) {
      return false;
    }

    openModal(limitsQuery.data.reason);
    return true;
  }

  async function settle() {
    await queryClient.invalidateQueries({ queryKey: teamKeys.all });
    await queryClient.invalidateQueries({ queryKey: limitKeys.all });
    form.reset();
    setOpen(false);
  }

  function onSend(values: InviteFormValues) {
    if (blockedByLimit()) {
      return;
    }

    invite.mutate(
      { data: { ...values, sendEmail: true } },
      {
        onSuccess: async () => {
          await settle();
          toast.success("Invitation sent successfully");
        },
      },
    );
  }

  function onCopyLink(values: InviteFormValues) {
    if (blockedByLimit()) {
      return;
    }

    invite.mutate(
      { data: { ...values, sendEmail: false } },
      {
        onSuccess: async (created) => {
          await navigator.clipboard.writeText(
            `${location.origin}/join-team?inviteId=${created.id}`,
          );
          await settle();
          toast.success("Invitation link copied to clipboard");
        },
      },
    );
  }

  function onOpenChange(next: boolean) {
    if (next === open) {
      return;
    }

    // The limit is checked on the way in as well as on submit, so someone on a
    // full plan sees the upgrade modal instead of a form they cannot submit.
    if (next && blockedByLimit()) {
      return;
    }

    setOpen(next);
  }

  if (!currentIsAdmin) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon className="mr-2 h-4 w-4" />
          Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSend)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field, formState }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder="colleague@example.com" {...field} />
                  </FormControl>
                  {formState.errors.email ? (
                    <FormMessage />
                  ) : (
                    <FormDescription>
                      Enter your colleague&apos;s email address
                    </FormDescription>
                  )}
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <div className="capitalize">
                          {field.value.toLowerCase()}
                        </div>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="ADMIN">
                        <div>Admin</div>
                        <div className="text-xs text-muted-foreground">
                          Manage users, update payments
                        </div>
                      </SelectItem>
                      <SelectItem value="MEMBER">
                        <div>Member</div>
                        <div className="text-xs text-muted-foreground">
                          Manage emails, domains and contacts
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {isSelfHosted() && domainsQuery.data?.length ? (
              <div className="text-sm text-muted-foreground">
                Will use{" "}
                <span className="font-bold">
                  hello@{domainsQuery.data[0]?.name}
                </span>{" "}
                to send invitation
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              {isSelfHosted() ? (
                <Button
                  type="button"
                  disabled={invite.isPending || limitsQuery.isLoading}
                  isLoading={invite.isPending}
                  className="w-[150px]"
                  onClick={form.handleSubmit(onCopyLink)}
                >
                  Copy Invitation
                </Button>
              ) : null}
              {isCloud() || domainsQuery.data?.length ? (
                <Button
                  type="submit"
                  disabled={invite.isPending || limitsQuery.isLoading}
                  isLoading={invite.isPending}
                  className="w-[150px]"
                >
                  Send Invitation
                </Button>
              ) : null}
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
