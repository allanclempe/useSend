import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { contactKeys } from "~/queries/contacts";
import { deleteContact } from "~/server/functions/contacts";

/**
 * Remove one contact, after typing their address back.
 *
 * `contactBookId` comes off the contact rather than from the page, because
 * `contactBookMiddleware` scopes the delete by it — this is the id the server
 * checks against the caller's team.
 */
export const DeleteContact: React.FC<{
  contact: { id: string; contactBookId: string; email: string };
}> = ({ contact }) => {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteContact,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      toast.success("Contact deleted");
    },
    onError: (error) => toast.error(`Contact not deleted: ${error.message}`),
  });

  const confirmationSchema = z
    .object({
      confirmation: z.string().email("Please enter a valid email address"),
    })
    .refine((values) => values.confirmation === contact.email, {
      message: "Email does not match",
      path: ["confirmation"],
    });

  return (
    <DeleteResource
      title="Delete Contact"
      resourceName={contact.email}
      schema={confirmationSchema}
      isLoading={remove.isPending}
      onConfirm={() =>
        remove.mutate({
          data: {
            contactId: contact.id,
            contactBookId: contact.contactBookId,
          },
        })
      }
      trigger={
        <Button variant="ghost" size="sm">
          <Trash2 className="h-4 w-4 text-red/80" />
        </Button>
      }
      confirmLabel="Delete Contact"
    />
  );
};

export default DeleteContact;
