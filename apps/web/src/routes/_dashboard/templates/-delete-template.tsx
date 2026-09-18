import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { templateKeys } from "~/queries/template";
import type { getTemplates } from "~/server/functions/template";
import { deleteTemplate } from "~/server/functions/template";

type TemplateListItem = Awaited<
  ReturnType<typeof getTemplates>
>["templates"][number];

export const DeleteTemplate: React.FC<{ template: TemplateListItem }> = ({
  template,
}) => {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: templateKeys.all });
      toast.success("Template deleted");
    },
    onError: (error) => toast.error(error.message),
  });

  const templateSchema = z
    .object({
      confirmation: z
        .string()
        .min(1, "Please type the template name to confirm"),
    })
    .refine((data) => data.confirmation === template.name, {
      message: "Template name does not match",
      path: ["confirmation"],
    });

  return (
    <DeleteResource
      title="Delete Template"
      resourceName={template.name}
      schema={templateSchema}
      isLoading={remove.isPending}
      onConfirm={() => remove.mutate({ data: { templateId: template.id } })}
      trigger={
        <Button variant="ghost" size="sm" className="p-0 hover:bg-transparent">
          <Trash2 className="h-[18px] w-[18px] text-red/80" />
        </Button>
      }
      confirmLabel="Delete Template"
    />
  );
};

export default DeleteTemplate;
