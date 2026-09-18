import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Badge } from "@usesend/ui/src/badge";
import { Button } from "@usesend/ui/src/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@usesend/ui/src/form";
import { Input } from "@usesend/ui/src/input";
import Spinner from "@usesend/ui/src/spinner";
import { Switch } from "@usesend/ui/src/switch";
import { toast } from "@usesend/ui/src/toaster";

import {
  findUserByEmail,
  rejectWaitlistUser,
  updateUserWaitlist,
} from "~/server/functions/admin";
import { isCloud } from "~/utils/common";

/**
 * `/admin/waitlist` — look one person up and let them in.
 *
 * Deliberately not a query: `findUserByEmail` answers about one address at a
 * time, there is nothing to invalidate and nothing a second caller would want
 * from the cache, so it is a mutation held in component state. It is also why
 * it is a `POST` even though it only reads — a `GET` server function puts its
 * input in the URL, and the input here is somebody's email address.
 */
const searchSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .email("Enter a valid email address"),
});

type SearchInput = z.infer<typeof searchSchema>;
type FoundUser = NonNullable<Awaited<ReturnType<typeof findUserByEmail>>>;

export const Route = createFileRoute("/_dashboard/admin/waitlist")({
  component: AdminWaitlistPage,
});

function AdminWaitlistPage() {
  const [user, setUser] = useState<FoundUser | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const form = useForm<SearchInput>({
    resolver: zodResolver(searchSchema),
    defaultValues: { email: "" },
  });

  const lookup = useMutation({
    mutationFn: findUserByEmail,
    onSuccess: (found) => {
      setHasSearched(true);
      setUser(found);

      if (!found) {
        toast.info("No user found for that email");
      }
    },
    onError: (error) =>
      toast.error(error.message || "Unable to search for user"),
  });

  const setWaitlisted = useMutation({
    mutationFn: updateUserWaitlist,
    onSuccess: (updated) => {
      setUser(updated);
      toast.success(
        updated.isWaitlisted
          ? "User marked as waitlisted"
          : "User removed from waitlist",
      );
    },
    onError: (error) =>
      toast.error(error.message || "Unable to update waitlist flag"),
  });

  const reject = useMutation({
    mutationFn: rejectWaitlistUser,
    onSuccess: () => toast.success("Rejection email sent"),
    onError: (error) =>
      toast.error(error.message || "Unable to send rejection email"),
  });

  if (!isCloud()) {
    return (
      <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
        Waitlist tooling is available only in the cloud deployment.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-6 shadow-sm">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => {
              setHasSearched(false);
              setUser(null);
              lookup.mutate({ data: values });
            })}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>User email</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="user@example.com"
                      autoComplete="off"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={lookup.isPending}>
              {lookup.isPending ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" /> Searching...
                </>
              ) : (
                "Lookup user"
              )}
            </Button>
          </form>
        </Form>
      </div>

      {!lookup.isPending && hasSearched && !user ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No user matched that email. Try another search.
        </div>
      ) : null}

      {user ? (
        <div className="space-y-4 rounded-lg border p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="text-base font-medium">{user.email}</p>
            </div>
            <Badge variant={user.isWaitlisted ? "destructive" : "outline"}>
              {user.isWaitlisted ? "Waitlisted" : "Active"}
            </Badge>
          </div>

          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground">Name</p>
              <p>{user.name || "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Joined</p>
              <p>
                {formatDistanceToNow(new Date(user.createdAt), {
                  addSuffix: true,
                })}
              </p>
            </div>
          </div>

          <div className="space-y-4 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Waitlist access</p>
                <p className="text-sm text-muted-foreground">
                  Toggle to control whether the user remains on the waitlist.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={user.isWaitlisted}
                  disabled={setWaitlisted.isPending}
                  onCheckedChange={(isWaitlisted) =>
                    setWaitlisted.mutate({
                      data: { userId: user.id, isWaitlisted },
                    })
                  }
                />
                {setWaitlisted.isPending ? (
                  <Spinner className="h-4 w-4" />
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Reject waitlist request</p>
                <p className="text-sm text-muted-foreground">
                  Send the applicant a rejection email without changing their
                  waitlist status.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={reject.isPending}
                onClick={() => reject.mutate({ data: { userId: user.id } })}
              >
                {reject.isPending ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" /> Sending...
                  </>
                ) : (
                  "Send rejection email"
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
