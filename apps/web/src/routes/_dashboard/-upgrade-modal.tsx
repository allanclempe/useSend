import { useMutation } from "@tanstack/react-query";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@usesend/ui/src/dialog";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { CheckCircle2 } from "lucide-react";

import { PLAN_PERKS } from "~/lib/constants/payments";
import { LimitReason } from "~/lib/constants/plans";
import { createCheckoutSession } from "~/server/functions/billing";
import { useUpgradeModalStore } from "~/store/upgradeModalStore";

/**
 * Opened by anything that hits a plan limit, through
 * `useUpgradeModalStore`. It lives in the dashboard layout rather than next to
 * the dialogs that open it, because several of them can be mounted at once and
 * only one modal should exist.
 */
const MESSAGES: Record<LimitReason, string> = {
  [LimitReason.DOMAIN]: "You've reached the domain limit for your current plan.",
  [LimitReason.CONTACT_BOOK]:
    "You've reached the contact book limit for your current plan.",
  [LimitReason.TEAM_MEMBER]:
    "You've reached the team member limit for your current plan.",
  [LimitReason.WEBHOOK]:
    "You've reached the webhook limit for your current plan.",
  [LimitReason.EMAIL_BLOCKED]:
    "You've reached the email sending limit for your current plan.",
  [LimitReason.EMAIL_DAILY_LIMIT_REACHED]:
    "You've reached the email sending limit for your current plan.",
  [LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED]:
    "You've reached the email sending limit for your current plan.",
};

export const UpgradeModal = () => {
  const {
    isOpen,
    reason,
    action: { closeModal },
  } = useUpgradeModalStore();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade to Basic Plan</DialogTitle>
          <DialogDescription>
            {reason
              ? `${MESSAGES[reason] ?? ""} Upgrade to unlock this feature and more.`
              : "Unlock more features with our Basic plan."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <h4 className="mb-3 font-medium">What you&apos;ll get:</h4>
            <ul className="space-y-2">
              {(PLAN_PERKS.BASIC ?? []).map((perk) => (
                <li key={perk} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green" />
                  <span className="text-sm">{perk}</span>
                </li>
              ))}
            </ul>
          </div>

          <UpgradeButton />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const UpgradeButton = () => {
  const checkout = useMutation({
    mutationFn: () => createCheckoutSession(),
    onSuccess: (url) => {
      if (url) {
        // Stripe's hosted checkout: a full navigation, not a router one.
        window.location.href = url;
      }
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Button
      onClick={() => checkout.mutate()}
      className="mt-4 w-[120px]"
      disabled={checkout.isPending}
    >
      {checkout.isPending ? <Spinner className="h-4 w-4" /> : "Upgrade"}
    </Button>
  );
};
