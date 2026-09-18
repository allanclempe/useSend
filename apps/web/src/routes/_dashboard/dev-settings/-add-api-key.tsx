import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ClipboardCopy, Eye, EyeOff, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { createToken } from "~/server/functions/api-key";
import { ApiPermission } from "~/types/db";

const apiKeySchema = z.object({
  name: z.string({ required_error: "Name is required" }).min(1, {
    message: "Name is required",
  }),
  domainId: z.string().optional(),
});

/**
 * `createToken` is the only call that ever sees the token itself, so the
 * dialog holds it in component state until it is dismissed — there is nowhere
 * to fetch it from a second time.
 */
export default function AddApiKey() {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const domainsQuery = useQuery(domainQueries.list());
  const queryClient = useQueryClient();

  const apiKeyForm = useForm<z.infer<typeof apiKeySchema>>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: {
      name: "",
      domainId: "all",
    },
  });

  const createApiKeyMutation = useMutation({
    mutationFn: createToken,
    onSuccess: async (token) => {
      await queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
      setApiKey(token);
      apiKeyForm.reset();
    },
    onError: (error) => toast.error(error.message),
  });

  function handleSave(values: z.infer<typeof apiKeySchema>) {
    createApiKeyMutation.mutate({
      data: {
        name: values.name,
        permission: ApiPermission.FULL,
        domainId:
          values.domainId === "all" ? undefined : Number(values.domainId),
      },
    });
  }

  function handleCopy() {
    void navigator.clipboard.writeText(apiKey);
    setIsCopied(true);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  function copyAndClose() {
    handleCopy();
    setApiKey("");
    setOpen(false);
    setShowApiKey(false);
    toast.success("API key copied to clipboard");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? setOpen(next) : null)}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" />
          Add API Key
        </Button>
      </DialogTrigger>
      {apiKey ? (
        <DialogContent key={apiKey}>
          <DialogHeader>
            <DialogTitle>Copy API key</DialogTitle>
          </DialogHeader>
          <div className="mt-2 flex items-center justify-between rounded-lg bg-secondary px-4 py-1">
            <div>
              {showApiKey ? (
                <p className="text-sm">{apiKey}</p>
              ) : (
                <div className="flex gap-1">
                  {Array.from({ length: 40 }).map((_, index) => (
                    <div
                      key={index}
                      className="h-1 w-1 rounded-lg bg-muted-foreground"
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-4">
              <Button
                variant="ghost"
                className="cursor-pointer p-0 hover:bg-transparent group-hover:opacity-100"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <EyeOff className="h-4 w-4" />
                )}
              </Button>

              <Button
                variant="ghost"
                className="cursor-pointer p-0 hover:bg-transparent group-hover:opacity-100"
                onClick={handleCopy}
              >
                {isCopied ? (
                  <CheckIcon className="h-4 w-4 text-green" />
                ) : (
                  <ClipboardCopy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              onClick={copyAndClose}
              disabled={createApiKeyMutation.isPending}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new API key</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Form {...apiKeyForm}>
              <form
                onSubmit={apiKeyForm.handleSubmit(handleSave)}
                className="space-y-8"
              >
                <FormField
                  control={apiKeyForm.control}
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
                  control={apiKeyForm.control}
                  name="domainId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Domain access</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
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
                    className="w-[100px] hover:bg-gray-100 focus:bg-gray-100"
                    type="submit"
                    disabled={createApiKeyMutation.isPending}
                  >
                    {createApiKeyMutation.isPending ? "Creating..." : "Create"}
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
