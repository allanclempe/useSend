import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usesend/ui/src/select";
import Spinner from "@usesend/ui/src/spinner";
import { Switch } from "@usesend/ui/src/switch";
import { toast } from "@usesend/ui/src/toaster";

import { findTeam, updateTeamSettings } from "~/server/functions/admin";
import { isCloud } from "~/utils/common";

/**
 * `/admin/teams` — find one team and change its limits.
 *
 * Like the waitlist page, the lookup is a mutation rather than a query: it
 * answers about one team at a time and there is nothing to cache. It is a
 * `POST` for the same reason too — the query matches on member email, so the
 * input can be somebody's address and does not belong in a URL.
 *
 * **The cloud check moved above the hooks rather than between them.** The
 * Next.js page called `useForm` twice, then `return`ed early for a self-hosted
 * installation, then called `useMutation` twice — conditional hooks, which
 * only failed to blow up because `isCloud()` never changes within a session.
 * The route splits into a gate and a component so the rule holds by
 * construction.
 */
const searchSchema = z.object({
  query: z
    .string({
      required_error:
        "Enter a team ID, name, domain, member email, or subscription ID",
    })
    .trim()
    .min(1, "Enter a team ID, name, domain, member email, or subscription ID"),
});

const updateSchema = z.object({
  apiRateLimit: z.coerce.number().int().min(1).max(10_000),
  dailyEmailLimit: z.coerce.number().int().min(0).max(10_000_000),
  isBlocked: z.boolean(),
  plan: z.enum(["FREE", "BASIC"]),
});

type SearchInput = z.infer<typeof searchSchema>;
type UpdateInput = z.infer<typeof updateSchema>;
type FoundTeam = NonNullable<Awaited<ReturnType<typeof findTeam>>>;

export const Route = createFileRoute("/_dashboard/admin/teams")({
  component: AdminTeamsRoute,
});

function AdminTeamsRoute() {
  if (!isCloud()) {
    return (
      <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
        Team administration tools are available only in the cloud deployment.
      </div>
    );
  }

  return <AdminTeamsPage />;
}

function AdminTeamsPage() {
  const [team, setTeam] = useState<FoundTeam | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const searchForm = useForm<SearchInput>({
    resolver: zodResolver(searchSchema),
    defaultValues: { query: "" },
  });

  const updateForm = useForm<UpdateInput>({
    resolver: zodResolver(updateSchema),
    defaultValues: {
      apiRateLimit: 1,
      dailyEmailLimit: 0,
      isBlocked: false,
      plan: "FREE",
    },
  });

  useEffect(() => {
    if (team) {
      updateForm.reset({
        apiRateLimit: team.apiRateLimit,
        dailyEmailLimit: team.dailyEmailLimit,
        isBlocked: team.isBlocked,
        plan: team.plan,
      });
    }
  }, [team, updateForm]);

  const lookup = useMutation({
    mutationFn: findTeam,
    onSuccess: (found) => {
      setHasSearched(true);
      setTeam(found);

      if (!found) {
        toast.info("No team found for that query");
      }
    },
    onError: (error) =>
      toast.error(error.message || "Unable to search for team"),
  });

  const update = useMutation({
    mutationFn: updateTeamSettings,
    onSuccess: (updated) => {
      setTeam(updated);
      toast.success("Team settings updated");
    },
    onError: (error) =>
      toast.error(error.message || "Unable to update team settings"),
  });

  return (
    <div className="space-y-8">
      <div className="rounded-lg border p-6 shadow-sm">
        <Form {...searchForm}>
          <form
            onSubmit={searchForm.handleSubmit((values) => {
              setTeam(null);
              setHasSearched(false);
              lookup.mutate({ data: values });
            })}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={searchForm.control}
              name="query"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Team lookup</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Team ID, team name, domain, member email, or subscription ID"
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
                "Lookup team"
              )}
            </Button>
          </form>
        </Form>
      </div>

      {!lookup.isPending && hasSearched && !team ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No team matched that query. Try another search.
        </div>
      ) : null}

      {team ? (
        <div className="space-y-6 rounded-lg border p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Team</p>
              <p className="text-xl font-semibold">{team.name}</p>
              <p className="text-xs text-muted-foreground">
                ID #{team.id} • Created{" "}
                {formatDistanceToNow(new Date(team.createdAt), {
                  addSuffix: true,
                })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Plan: {team.plan}</Badge>
              <Badge variant={team.isBlocked ? "destructive" : "outline"}>
                {team.isBlocked ? "Blocked" : "Active"}
              </Badge>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                Members
              </h3>
              <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                {team.teamUsers.length ? (
                  team.teamUsers.map((member) => (
                    <div
                      key={member.user.id}
                      className="flex items-center justify-between rounded-md bg-background px-3 py-2 text-sm"
                    >
                      <div>
                        <p className="font-medium">
                          {member.user.name || member.user.email}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {member.user.email}
                        </p>
                      </div>
                      <Badge variant="outline">{member.role}</Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No members found.
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                Domains
              </h3>
              <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                {team.domains.length ? (
                  team.domains.map((domain) => (
                    <div
                      key={domain.id}
                      className="flex items-center justify-between rounded-md bg-background px-3 py-2 text-sm"
                    >
                      <span>{domain.name}</span>
                      <Badge
                        variant={
                          domain.status === "SUCCESS" ? "outline" : "secondary"
                        }
                      >
                        {domain.status === "SUCCESS"
                          ? "Verified"
                          : domain.status.toLowerCase()}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No domains connected.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/10 p-4">
            <p className="text-sm text-muted-foreground">
              Billing contact: {team.billingEmail || "Not set"}
            </p>
          </div>

          <div className="rounded-lg border p-6">
            <Form {...updateForm}>
              <form
                onSubmit={updateForm.handleSubmit((values) =>
                  update.mutate({ data: { teamId: team.id, ...values } }),
                )}
                className="grid gap-6 lg:grid-cols-2"
              >
                <FormField
                  control={updateForm.control}
                  name="apiRateLimit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API rate limit</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={10_000}
                          {...field}
                          onChange={(event) =>
                            field.onChange(Number(event.target.value))
                          }
                          disabled={update.isPending}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={updateForm.control}
                  name="dailyEmailLimit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Daily email limit</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={10_000_000}
                          {...field}
                          onChange={(event) =>
                            field.onChange(Number(event.target.value))
                          }
                          disabled={update.isPending}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={updateForm.control}
                  name="plan"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Plan</FormLabel>
                      <FormControl>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={update.isPending}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select plan" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="FREE">Free</SelectItem>
                            <SelectItem value="BASIC">Basic</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={updateForm.control}
                  name="isBlocked"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Blocked</FormLabel>
                      <FormControl>
                        <div className="flex items-center gap-3 rounded-md border px-3 py-2">
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            disabled={update.isPending}
                          />
                          <span className="text-sm text-muted-foreground">
                            {field.value ? "Team is blocked" : "Team is active"}
                          </span>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end lg:col-span-2">
                  <Button type="submit" disabled={update.isPending}>
                    {update.isPending ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" /> Saving...
                      </>
                    ) : (
                      "Update team"
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
