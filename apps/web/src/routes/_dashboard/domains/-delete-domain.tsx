import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { domainKeys } from "~/queries/domain";
import { deleteDomain } from "~/server/functions/domain";
import type { Domain } from "~/types/db";

export const DeleteDomain: React.FC<{ domain: Domain }> = ({ domain }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const remove = useMutation({
    mutationFn: deleteDomain,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: domainKeys.all });
      toast.success(`Domain ${domain.name} deleted`);
      await navigate({ to: "/domains", replace: true });
    },
    onError: (error) => toast.error(error.message),
  });

  const domainSchema = z
    .object({
      confirmation: z.string().min(1, "Please type the domain name to confirm"),
    })
    .refine((data) => data.confirmation === domain.name, {
      message: "Domain name does not match",
      path: ["confirmation"],
    });

  return (
    <DeleteResource
      title="Delete domain"
      resourceName={domain.name}
      schema={domainSchema}
      isLoading={remove.isPending}
      onConfirm={() => remove.mutate({ data: { id: domain.id } })}
      trigger={
        <Button variant="destructive" className="w-[150px]" size="sm">
          Delete domain
        </Button>
      }
      confirmLabel="Delete domain"
    />
  );
};

export default DeleteDomain;
