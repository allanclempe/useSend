import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Edit } from "lucide-react";
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
import { Switch } from "@usesend/ui/src/switch";
import { toast } from "@usesend/ui/src/toaster";

import {
  getContactPropertyValue,
  replaceContactVariableValues,
} from "~/lib/contact-properties";
import { contactKeys } from "~/queries/contacts";
import { updateContact } from "~/server/functions/contacts";

const formSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  subscribed: z.boolean().optional(),
});

type EditContactFormValues = z.infer<typeof formSchema>;

type EditableContact = {
  id: string;
  contactBookId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  subscribed?: boolean | null;
  properties: Record<string, string>;
};

/**
 * Edit one contact, including whatever variables its contact book defines.
 *
 * The book's variables are not form fields — they are decided by the book, not
 * by this schema — so they are held in their own state map and merged back
 * through `replaceContactVariableValues`, which preserves any property the
 * book does not declare. Writing `properties` wholesale from the visible
 * inputs would silently drop those.
 *
 * `key={open}` on the content remounts the form each time it opens, which is
 * what the Next.js version's `useEffect`-that-reconciles-two-maps was for.
 */
export const EditContact: React.FC<{
  contact: EditableContact;
  contactBookVariables?: Array<string>;
}> = ({ contact, contactBookVariables }) => {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Edit className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent key={String(open)}>
        <DialogHeader>
          <DialogTitle>Edit Contact</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <EditContactForm
            contact={contact}
            contactBookVariables={contactBookVariables ?? []}
            onSaved={() => setOpen(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};

function EditContactForm({
  contact,
  contactBookVariables,
  onSaved,
}: {
  contact: EditableContact;
  contactBookVariables: Array<string>;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();

  const [variableValues, setVariableValues] = useState(() =>
    Object.fromEntries(
      contactBookVariables.map((variable) => [
        variable,
        getContactPropertyValue(
          contact.properties,
          variable,
          contactBookVariables,
        ) ?? "",
      ]),
    ),
  );

  const form = useForm<EditContactFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: contact.email,
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      subscribed: contact.subscribed ?? false,
    },
  });

  const update = useMutation({
    mutationFn: updateContact,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      onSaved();
      toast.success("Contact updated successfully");
    },
    onError: (error) => toast.error(error.message),
  });

  function onSubmit(values: EditContactFormValues) {
    const filled = Object.fromEntries(
      Object.entries(variableValues).filter(([, value]) => value.trim()),
    );

    update.mutate({
      data: {
        contactId: contact.id,
        contactBookId: contact.contactBookId,
        ...values,
        properties: replaceContactVariableValues(
          contact.properties,
          filled,
          contactBookVariables,
        ) as Record<string, string>,
      },
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <FormField
          control={form.control}
          name="email"
          render={({ field, formState }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="email@example.com" {...field} />
              </FormControl>
              {formState.errors.email ? <FormMessage /> : null}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="firstName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>First Name</FormLabel>
              <FormControl>
                <Input placeholder="First Name" {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="lastName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Last Name</FormLabel>
              <FormControl>
                <Input placeholder="Last Name" {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="subscribed"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2">
              <FormLabel>Subscribed</FormLabel>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  className="data-[state=checked]:bg-success"
                />
              </FormControl>
            </FormItem>
          )}
        />
        {contactBookVariables.map((variable) => {
          const inputId = `contact-variable-${contact.id}-${variable.replace(
            /[^a-zA-Z0-9_-]/g,
            "-",
          )}`;

          return (
            <FormItem key={variable}>
              <FormLabel htmlFor={inputId}>{variable}</FormLabel>
              <FormControl>
                <Input
                  id={inputId}
                  placeholder={variable}
                  value={variableValues[variable] ?? ""}
                  onChange={(event) =>
                    setVariableValues((previous) => ({
                      ...previous,
                      [variable]: event.target.value,
                    }))
                  }
                />
              </FormControl>
            </FormItem>
          );
        })}
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
  );
}

export default EditContact;
