import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@usesend/ui/src/form";
import { Input } from "@usesend/ui/src/input";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { campaignKeys } from "~/queries/campaign";
import { createCampaign } from "~/server/functions/campaign";

const formSchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .min(1, { message: "Name is required" }),
  from: z
    .string({ required_error: "From email is required" })
    .min(1, { message: "From email is required" }),
  subject: z
    .string({ required_error: "Subject is required" })
    .min(1, { message: "Subject is required" }),
});

type CreateCampaignFormValues = z.infer<typeof formSchema>;

/**
 * Name, from and subject, then straight into the editor.
 *
 * A campaign is created empty and edited; there is no "save draft" step, which
 * is why this closes by navigating rather than by returning to the list.
 */
export default function CreateCampaign() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const form = useForm<CreateCampaignFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", from: "", subject: "" },
  });

  const create = useMutation({
    mutationFn: createCampaign,
    onSuccess: async (campaign) => {
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
      setOpen(false);
      toast.success("Campaign created successfully");
      await navigate({
        to: "/campaigns/$campaignId/edit",
        params: { campaignId: campaign.id },
      });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" />
          Create Campaign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create new campaign</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((values) =>
                create.mutate({ data: values }),
              )}
              className="space-y-8"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Campaign Name" {...field} />
                    </FormControl>
                    {formState.errors.name ? <FormMessage /> : null}
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="from"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>From</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Friendly Name <from@example.com>"
                        {...field}
                      />
                    </FormControl>
                    {formState.errors.from ? <FormMessage /> : null}
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="subject"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Subject</FormLabel>
                    <FormControl>
                      <Input placeholder="Campaign Subject" {...field} />
                    </FormControl>
                    {formState.errors.subject ? <FormMessage /> : null}
                  </FormItem>
                )}
              />
              <p className="text-sm text-muted-foreground">
                Don&apos;t worry, you can change it later.
              </p>
              <div className="flex justify-end">
                <Button
                  className="w-[100px]"
                  type="submit"
                  disabled={create.isPending}
                >
                  {create.isPending ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    "Create"
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
