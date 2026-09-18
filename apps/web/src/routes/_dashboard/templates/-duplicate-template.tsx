import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import React, { useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import { toast } from "@usesend/ui/src/toaster";

import { templateKeys } from "~/queries/template";
import type { getTemplates } from "~/server/functions/template";
import { duplicateTemplate } from "~/server/functions/template";

type TemplateListItem = Awaited<
  ReturnType<typeof getTemplates>
>["templates"][number];

export const DuplicateTemplate: React.FC<{ template: TemplateListItem }> = ({
  template,
}) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const duplicate = useMutation({
    mutationFn: duplicateTemplate,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
      setOpen(false);
      toast.success("Template duplicated");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? setOpen(next) : null)}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="p-0 hover:bg-transparent">
          <Copy className="h-[18px] w-[18px] text-blue/80" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate Template</DialogTitle>
          <DialogDescription>
            Are you sure you want to duplicate{" "}
            <span className="font-semibold text-foreground">
              {template.name}
            </span>
            ?
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <div className="flex justify-end">
            <Button
              onClick={() =>
                duplicate.mutate({ data: { templateId: template.id } })
              }
              variant="default"
              disabled={duplicate.isPending}
            >
              {duplicate.isPending ? "Duplicating..." : "Duplicate"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DuplicateTemplate;
