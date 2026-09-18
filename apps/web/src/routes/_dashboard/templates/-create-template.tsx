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

import { templateKeys } from "~/queries/template";
import { createTemplate } from "~/server/functions/template";

const templateSchema = z.object({
  name: z.string({ required_error: "Name is required" }).min(1, {
    message: "Name is required",
  }),
  subject: z.string({ required_error: "Subject is required" }).min(1, {
    message: "Subject is required",
  }),
});

export default function CreateTemplate() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: createTemplate,
    onSuccess: async (template) => {
      await queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
      setOpen(false);
      toast.success("Template created successfully");
      await navigate({
        to: "/templates/$templateId/edit",
        params: { templateId: template.id },
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const templateForm = useForm<z.infer<typeof templateSchema>>({
    resolver: zodResolver(templateSchema),
    defaultValues: { name: "", subject: "" },
  });

  function onTemplateCreate(values: z.infer<typeof templateSchema>) {
    create.mutate({ data: values });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? setOpen(next) : null)}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" />
          Create Template
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create new template</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...templateForm}>
            <form
              onSubmit={templateForm.handleSubmit(onTemplateCreate)}
              className="space-y-8"
            >
              <FormField
                control={templateForm.control}
                name="name"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Template Name" {...field} />
                    </FormControl>
                    {formState.errors.name ? <FormMessage /> : null}
                  </FormItem>
                )}
              />
              <FormField
                control={templateForm.control}
                name="subject"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Subject</FormLabel>
                    <FormControl>
                      <Input placeholder="Template Subject" {...field} />
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
