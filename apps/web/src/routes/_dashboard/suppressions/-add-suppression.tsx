import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import { Input } from "@usesend/ui/src/input";
import { Label } from "@usesend/ui/src/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usesend/ui/src/select";

import { suppressionKeys, suppressionQueries } from "~/queries/suppression";
import { addSuppression } from "~/server/functions/suppression";
import { SuppressionReason } from "~/types/db";

const emailSchema = z.string().email();

/**
 * Suppress one address by hand.
 *
 * The "already suppressed" check is a `fetchQuery` rather than the Next.js
 * version's `useQuery({ enabled: false })` + `refetch()`: that pattern existed
 * only because tRPC's hook could not be called imperatively, and it left a
 * stale cache entry keyed on whatever was in the input the last time. It is a
 * courtesy check either way — the service is the thing that actually refuses a
 * duplicate — so a failure to reach it does not block the submit.
 *
 * Self-contained, like `-add-domain.tsx`: it owns the button that opens it, so
 * the page does not hold a boolean for a dialog it otherwise knows nothing
 * about.
 */
export default function AddSuppression() {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<SuppressionReason>(
    SuppressionReason.MANUAL,
  );
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: addSuppression,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: suppressionKeys.all });
      close();
    },
    onError: (err) => setError(err.message),
  });

  function close() {
    setEmail("");
    setReason(SuppressionReason.MANUAL);
    setError(null);
    setOpen(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();
    const parsed = emailSchema.safeParse(trimmed);

    if (!parsed.success) {
      setError("Please enter a valid email address");
      return;
    }

    try {
      const alreadySuppressed = await queryClient.fetchQuery(
        suppressionQueries.check(parsed.data),
      );

      if (alreadySuppressed) {
        setError("This email is already suppressed");
        return;
      }
    } catch {
      // The check is advisory; the add below is the authority.
    }

    add.mutate({ data: { email: parsed.data, reason } });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Suppression
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Email Suppression</DialogTitle>
          <DialogDescription>
            Add an email address to the suppression list to prevent future
            emails from being sent to it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              placeholder="example@domain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={add.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason</Label>
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as SuppressionReason)}
              disabled={add.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SuppressionReason.MANUAL}>Manual</SelectItem>
                <SelectItem value={SuppressionReason.HARD_BOUNCE}>
                  Hard Bounce
                </SelectItem>
                <SelectItem value={SuppressionReason.COMPLAINT}>
                  Complaint
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={add.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending || !email.trim()}>
              {add.isPending ? "Adding..." : "Add Suppression"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
