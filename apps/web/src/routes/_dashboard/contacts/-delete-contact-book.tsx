import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { contactKeys } from "~/queries/contacts";
import { deleteContactBook } from "~/server/functions/contacts";
import type { ContactBook } from "~/types/db";

export const DeleteContactBook: React.FC<{
  contactBook: Partial<ContactBook> & { id: string };
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSuccess?: () => void | Promise<void>;
}> = ({ contactBook, trigger, open, onOpenChange, onSuccess }) => {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteContactBook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      await onSuccess?.();
      toast.success("Contact book deleted");
    },
    onError: (error) => toast.error(error.message),
  });

  const contactBookSchema = z
    .object({
      confirmation: z
        .string()
        .min(1, "Please type the contact book name to confirm"),
    })
    .refine((data) => data.confirmation === contactBook.name, {
      message: "Contact book name does not match",
      path: ["confirmation"],
    });

  const dialogTrigger =
    trigger ??
    (open === undefined ? (
      <Button variant="ghost" size="sm" className="p-0 hover:bg-transparent">
        <Trash2 className="h-[18px] w-[18px] text-red/80 hover:text-red/70" />
      </Button>
    ) : null);

  return (
    <DeleteResource
      title="Delete Contact Book"
      resourceName={contactBook.name || ""}
      schema={contactBookSchema}
      isLoading={remove.isPending}
      onConfirm={() =>
        remove.mutate({ data: { contactBookId: contactBook.id } })
      }
      open={open}
      onOpenChange={onOpenChange}
      trigger={dialogTrigger}
      confirmLabel="Delete Contact Book"
    />
  );
};

export default DeleteContactBook;
