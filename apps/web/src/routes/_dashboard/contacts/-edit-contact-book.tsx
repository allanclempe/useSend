import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Edit } from "lucide-react";
import { useState, type ReactNode } from "react";
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

import { contactKeys } from "~/queries/contacts";
import { updateContactBook } from "~/server/functions/contacts";

const contactBookSchema = z.object({
  name: z.string().min(1, { message: "Name is required" }),
  variables: z.string().optional(),
});

/**
 * Edit a contact book, from the list card and from the book's own page.
 *
 * It takes `open`/`onOpenChange` because the detail page drives it from an
 * actions menu that has already closed by the time the dialog opens, and its
 * own trigger otherwise. `onSuccess` is how the caller adds an invalidation of
 * its own — the book list is always invalidated here.
 */
export const EditContactBook: React.FC<{
  contactBook: { id: string; name: string; variables?: string[] };
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: React.Dispatch<React.SetStateAction<boolean>>;
  onSuccess?: () => void | Promise<void>;
}> = ({
  contactBook,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onSuccess,
}) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const update = useMutation({
    mutationFn: updateContactBook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      await onSuccess?.();
      if (controlledOpen === undefined) {
        setOpen(false);
      } else {
        onOpenChange?.(false);
      }
      toast.success("Contact book updated successfully");
    },
    onError: (error) => toast.error(error.message),
  });

  const dialogTrigger =
    trigger ??
    (controlledOpen === undefined ? (
      <Button
        variant="ghost"
        size="sm"
        className="p-0 hover:bg-transparent"
        onClick={(e) => e.stopPropagation()}
      >
        <Edit className="h-4 w-4 text-foreground/80 hover:text-foreground/70" />
      </Button>
    ) : null);

  const contactBookForm = useForm<z.infer<typeof contactBookSchema>>({
    resolver: zodResolver(contactBookSchema),
    defaultValues: {
      name: contactBook.name || "",
      variables: (contactBook.variables ?? []).join(", "),
    },
  });

  function onContactBookUpdate(values: z.infer<typeof contactBookSchema>) {
    update.mutate({
      data: {
        contactBookId: contactBook.id,
        name: values.name,
        variables: values.variables
          ?.split(",")
          .map((variable) => variable.trim())
          .filter(Boolean),
      },
    });
  }

  return (
    <Dialog
      open={controlledOpen ?? open}
      onOpenChange={(nextOpen) => {
        if (controlledOpen === undefined) {
          if (nextOpen !== open) {
            setOpen(nextOpen);
          }
          return;
        }

        onOpenChange?.(nextOpen);
      }}
    >
      {dialogTrigger ? (
        <DialogTrigger asChild>{dialogTrigger}</DialogTrigger>
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Contact Book</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...contactBookForm}>
            <form
              onSubmit={contactBookForm.handleSubmit(onContactBookUpdate)}
              className="space-y-8"
            >
              <FormField
                control={contactBookForm.control}
                name="name"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Contact Book Name" {...field} />
                    </FormControl>
                    {formState.errors.name ? <FormMessage /> : null}
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
                      Comma-separated variable names available in campaigns for
                      this contact book.
                    </FormDescription>
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button
                  className="w-[100px]"
                  type="submit"
                  disabled={update.isPending}
                >
                  {update.isPending ? "Updating..." : "Update"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default EditContactBook;
