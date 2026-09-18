import { useMutation } from "@tanstack/react-query";

import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { createCheckoutSession } from "~/server/functions/billing";

/**
 * Sends the user to Stripe's hosted checkout.
 *
 * `routes/_dashboard/-upgrade-modal.tsx` has a private copy of this, because
 * the modal is mounted by the dashboard layout and lives with it. Rather than
 * export one from the other and tie a layout file to a settings page, each
 * keeps the eight lines it needs; they are the same eight lines and are meant
 * to be.
 */
export const UpgradeButton = () => {
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
