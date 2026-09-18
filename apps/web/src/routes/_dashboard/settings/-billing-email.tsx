import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@usesend/ui/src/button";
import { Card } from "@usesend/ui/src/card";
import { Input } from "@usesend/ui/src/input";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { teamKeys } from "~/queries/team";
import { updateBillingEmail } from "~/server/functions/billing";
import { useTeam } from "../-team-context";

/**
 * Where the invoices go.
 *
 * The address is a column on the team, so saving it invalidates `teamKeys.all`
 * rather than anything under `billingKeys` — the team query is what the header
 * and this card both read it from.
 *
 * The Next.js version swallowed a failure into `console.error` and left the
 * field open with the old value still on the server. It toasts now, like every
 * other mutation in the dashboard.
 */
export function BillingEmail() {
  const { currentTeam } = useTeam();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [billingEmail, setBillingEmail] = useState(
    currentTeam?.billingEmail ?? "",
  );

  const save = useMutation({
    mutationFn: updateBillingEmail,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamKeys.all });
      setIsEditing(false);
      toast.success("Billing email updated");
    },
    onError: (error) => toast.error(error.message),
  });

  function startEditing() {
    setBillingEmail(currentTeam?.billingEmail ?? "");
    setIsEditing(true);
  }

  return (
    <Card className="p-6">
      <div className="text-sm text-muted-foreground">Billing Email</div>
      {isEditing ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="email"
            value={billingEmail}
            onChange={(e) => setBillingEmail(e.target.value)}
            placeholder="Enter billing email"
          />
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate({ data: { billingEmail } })}
          >
            {save.isPending ? <Spinner className="h-4 w-4" /> : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setIsEditing(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <div className="font-mono">
            {currentTeam?.billingEmail || "No billing email set"}
          </div>
          <Button size="sm" onClick={startEditing}>
            Edit
          </Button>
        </div>
      )}
    </Card>
  );
}

export default BillingEmail;
