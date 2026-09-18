import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormMessage,
} from "@usesend/ui/src/form";
import { Input } from "@usesend/ui/src/input";
import { Spinner } from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { teamKeys } from "~/queries/team";
import { createTeam } from "~/server/functions/team";
import { JoinTeam } from "../-join-team";

/**
 * Shown instead of the dashboard when the signed-in user belongs to no team.
 *
 * It offers both halves the Next.js version did: any pending invitations
 * first, then the form to create a team. `JoinTeam` renders nothing when there
 * are no invitations, so a first user on a fresh installation sees only the
 * form.
 *
 * This is also the reference shape for a mutation in the ported dashboard:
 * `useMutation` with the server function as `mutationFn`, and invalidation
 * through a key from the area's `queries/` module — which is what
 * `api.useUtils().team.invalidate()` used to be.
 */
const formSchema = z.object({
  name: z
    .string()
    .min(2, { message: "Team name must be at least 2 characters." }),
});

export function CreateTeam() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "" },
  });

  const create = useMutation({
    mutationFn: (data: z.infer<typeof formSchema>) => createTeam({ data }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamKeys.all });
      await router.navigate({ to: "/dashboard", replace: true });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex w-[400px] flex-col gap-8">
        <JoinTeam showCreateTeam />
        <div>
          <h1 className="text-center font-semibold">Create Team</h1>
        </div>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((data) => create.mutate(data))}
            className="flex w-full flex-col gap-8"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field, formState }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      placeholder="Team name"
                      className="w-full"
                      {...field}
                    />
                  </FormControl>
                  {formState.errors.name ? (
                    <FormMessage />
                  ) : (
                    <FormDescription>
                      Request admin to join existing team
                    </FormDescription>
                  )}
                </FormItem>
              )}
            />
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Spinner className="h-5 w-5" /> : "Create"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
