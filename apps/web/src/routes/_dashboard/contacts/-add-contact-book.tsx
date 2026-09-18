import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
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
import { toast } from "@usesend/ui/src/toaster";

import { LimitReason } from "~/lib/constants/plans";
import { contactKeys } from "~/queries/contacts";
import { limitKeys, limitQueries } from "~/queries/limits";
import { createContactBook } from "~/server/functions/contacts";
import { useUpgradeModalStore } from "~/store/upgradeModalStore";

const contactBookSchema = z.object({
  name: z.string({ required_error: "Name is required" }).min(1, {
    message: "Name is required",
  }),
  variables: z.string().optional(),
});

export default function AddContactBook() {
  const [open, setOpen] = useState(false);

  const limitsQuery = useQuery(limitQueries.detail(LimitReason.CONTACT_BOOK));
  const { openModal } = useUpgradeModalStore((s) => s.action);

  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: createContactBook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      // The new book counts against the plan, so the next dialog must not be
      // told the old answer.
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      contactBookForm.reset();
      setOpen(false);
      toast.success("Contact book created successfully");
    },
    onError: (error) => toast.error(error.message),
  });

  const contactBookForm = useForm<z.infer<typeof contactBookSchema>>({
    resolver: zodResolver(contactBookSchema),
    defaultValues: { name: "", variables: "" },
  });

  function handleSave(values: z.infer<typeof contactBookSchema>) {
    if (limitsQuery.data?.isLimitReached) {
      openModal(limitsQuery.data.reason);
      return;
    }

    create.mutate({
      data: {
        name: values.name,
        variables: values.variables
          ?.split(",")
          .map((variable) => variable.trim())
          .filter(Boolean),
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
          Add Contact Book
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new contact book</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...contactBookForm}>
            <form
              onSubmit={contactBookForm.handleSubmit(handleSave)}
              className="space-y-8"
            >
              <FormField
                control={contactBookForm.control}
                name="name"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Contact book name</FormLabel>
                    <FormControl>
                      <Input placeholder="My contacts" {...field} />
                    </FormControl>
                    {formState.errors.name ? (
                      <FormMessage />
                    ) : (
                      <FormDescription>
                        eg: product / website / newsletter name
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
              <FormField
                control={contactBookForm.control}
                name="variables"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Variables</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="registrationCode, company, plan"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Optional comma-separated variable names for campaign
                      personalization.
                    </FormDescription>
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button
                  className="w-[100px]"
                  type="submit"
                  disabled={create.isPending || limitsQuery.isLoading}
                >
                  {create.isPending ? "Creating..." : "Create"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
