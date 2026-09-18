import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Textarea } from "@usesend/ui/src/textarea";
import { toast } from "@usesend/ui/src/toaster";

import { contactKeys } from "~/queries/contacts";
import { addContacts } from "~/server/functions/contacts";

const formSchema = z.object({
  contacts: z.string({ required_error: "Contacts are required" }).min(1, {
    message: "Contacts are required",
  }),
});

type AddContactFormValues = z.infer<typeof formSchema>;

/**
 * Paste a comma-separated list of addresses into a contact book.
 *
 * Controlled, because it is opened from the page's Actions popover rather than
 * by a trigger of its own — the popover has to close before the dialog opens.
 * The Next.js component supported *both* modes with a `controlledOpen ===
 * undefined` branch in four places; nothing ever used the uncontrolled one.
 *
 * The toast says "queued", not "added": `addContacts` hands the list to the
 * contact queue and returns before any of them exist.
 */
export default function AddContact({
  contactBookId,
  open,
  onOpenChange,
}: {
  contactBookId: string;
  open: boolean;
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const queryClient = useQueryClient();

  const form = useForm<AddContactFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { contacts: "" },
  });

  const add = useMutation({
    mutationFn: addContacts,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      form.reset();
      onOpenChange(false);
      toast.success("Contacts queued for processing");
    },
    onError: (error) => toast.error(error.message),
  });

  function onSubmit(values: AddContactFormValues) {
    add.mutate({
      data: {
        contactBookId,
        contacts: values.contacts
          .split(",")
          .map((email) => ({ email: email.trim() })),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add new contacts</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
              <FormField
                control={form.control}
                name="contacts"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Contacts</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="email1@example.com, email2@example.com"
                        onKeyDown={(event) => {
                          if (
                            !(event.metaKey || event.ctrlKey) ||
                            event.key !== "Enter" ||
                            add.isPending
                          ) {
                            return;
                          }

                          event.preventDefault();
                          void form.handleSubmit(onSubmit)();
                        }}
                        {...field}
                      />
                    </FormControl>
                    {formState.errors.contacts ? (
                      <FormMessage />
                    ) : (
                      <FormDescription>
                        Enter comma-separated email addresses. Press Cmd/Ctrl +
                        Enter to submit.
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button
                  className="w-[100px]"
                  type="submit"
                  disabled={add.isPending}
                >
                  {add.isPending ? "Adding..." : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
