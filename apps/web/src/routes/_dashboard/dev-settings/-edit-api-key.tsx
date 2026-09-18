import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
  SelectValue,
} from "@usesend/ui/src/select";
import { toast } from "@usesend/ui/src/toaster";

import { apiKeyKeys } from "~/queries/api-key";
import { domainQueries } from "~/queries/domain";
import { updateApiKey } from "~/server/functions/api-key";
import type { ApiKeyRow } from "./-api-key-row";

const editApiKeySchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .min(1, { message: "Name is required" }),
  domainId: z.string().optional(),
});

type EditApiKeyFormValues = z.infer<typeof editApiKeySchema>;

export function EditApiKeyDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: ApiKeyRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const domainsQuery = useQuery(domainQueries.list());
  const queryClient = useQueryClient();

  const form = useForm<EditApiKeyFormValues>({
    resolver: zodResolver(editApiKeySchema),
    defaultValues: {
      name: apiKey.name,
      domainId: apiKey.domainId ? apiKey.domainId.toString() : "all",
    },
  });

  // The dialog is mounted for every row in the table, so it is the same
  // component instance from one open to the next; without this it would show
  // whatever was last typed into it.
  useEffect(() => {
    if (open) {
      form.reset({
        name: apiKey.name,
        domainId: apiKey.domainId ? apiKey.domainId.toString() : "all",
      });
    }
  }, [open, apiKey, form]);

  const update = useMutation({
    mutationFn: updateApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
      toast.success("API key updated");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  function handleSubmit(values: EditApiKeyFormValues) {
    update.mutate({
      data: {
        id: apiKey.id,
        name: values.name,
        domainId: values.domainId === "all" ? null : Number(values.domainId),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit API key</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit)}
              className="space-y-8"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>API key name</FormLabel>
                    <FormControl>
                      <Input placeholder="prod key" {...field} />
                    </FormControl>
                    {formState.errors.name ? (
                      <FormMessage />
                    ) : (
                      <FormDescription>
                        Use a name to easily identify this API key.
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="domainId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Domain access</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select domain access" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="all">All Domains</SelectItem>
                        {domainsQuery.data?.map((domain) => (
                          <SelectItem
                            key={domain.id}
                            value={domain.id.toString()}
                          >
                            {domain.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Choose which domain this API key can send emails from.
                    </FormDescription>
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button
                  className="w-[120px] hover:bg-gray-100 focus:bg-gray-100"
                  type="submit"
                  disabled={update.isPending}
                >
                  {update.isPending ? "Saving..." : "Save changes"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
