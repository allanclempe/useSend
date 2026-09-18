import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Editor } from "@usesend/email-editor";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { Input } from "@usesend/ui/src/input";
import { Spinner } from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { templateKeys, templateQueries } from "~/queries/template";
import type { getTemplate } from "~/server/functions/template";
import {
  generateImagePresignedUrl,
  updateTemplate,
} from "~/server/functions/template";

const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;

type TemplateDetail = Awaited<ReturnType<typeof getTemplate>>;

export default function TemplateEditor({ templateId }: { templateId: string }) {
  const templateQuery = useQuery(templateQueries.detail(templateId));

  if (templateQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!templateQuery.data) {
    return <div>Template not found</div>;
  }

  return <TemplateForm template={templateQuery.data} />;
}

/**
 * The editor owns the name, the subject and the document while they are being
 * edited, and writes each back on its own trigger: the two inputs on blur, the
 * document a second after the last keystroke. That is why this component takes
 * a loaded template rather than fetching one — it seeds local state once, and
 * a later refetch must not pull the text out from under the cursor.
 */
function TemplateForm({ template }: { template: TemplateDetail }) {
  const queryClient = useQueryClient();

  const [json, setJson] = useState<Record<string, unknown> | undefined>(
    template.content ? JSON.parse(template.content) : undefined,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);

  const update = useMutation({
    mutationFn: updateTemplate,
    onSuccess: (saved) => {
      // The server hands back the row it wrote, so the cache can be corrected
      // without asking for it again — an autosave that fires every second of
      // typing should not also cost a round trip to re-read what it just sent.
      // The list is only marked stale: it is not mounted, so nothing refetches
      // until the user goes back to it and sees the new name.
      queryClient.setQueryData(
        templateKeys.detail(template.id),
        (previous: TemplateDetail | undefined) =>
          previous ? { ...previous, ...saved } : previous,
      );
      void queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
      setIsSaving(false);
    },
  });

  const saveContent = useDebouncedCallback(() => {
    update.mutate({
      data: { templateId: template.id, content: JSON.stringify(json) },
    });
  }, 1000);

  /**
   * Uploads go straight from the browser to R2 with a presigned URL, so the
   * image never passes through the Worker — which has a request body limit an
   * email banner can exceed.
   */
  async function handleFileChange(file: File) {
    if (file.size > IMAGE_SIZE_LIMIT) {
      throw new Error(
        `File should be less than ${IMAGE_SIZE_LIMIT / 1024 / 1024}MB`,
      );
    }

    const { uploadUrl, imageUrl } = await generateImagePresignedUrl({
      data: { templateId: template.id, name: file.name, type: file.type },
    });

    const response = await fetch(uploadUrl, { method: "PUT", body: file });

    if (!response.ok) {
      throw new Error("Failed to upload file");
    }

    return imageUrl;
  }

  return (
    <div className="container mx-auto p-4">
      <div className="mx-auto">
        <div className="mx-auto mb-4 flex w-full items-center justify-between sm:w-[700px]">
          <div className="flex items-center gap-3">
            <Link to="/templates">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border-0 px-0.5 focus:outline-none focus:ring-0 sm:w-[300px]"
              onBlur={() => {
                if (name === template.name || !name) {
                  return;
                }
                update.mutate(
                  { data: { templateId: template.id, name } },
                  {
                    onError: (error) => {
                      toast.error(`${error.message}. Reverting changes.`);
                      setName(template.name);
                    },
                  },
                );
              }}
            />
          </div>

          <div className="flex items-center gap-4 whitespace-nowrap">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              {isSaving ? (
                <div className="h-2 w-2 rounded-full bg-yellow" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-green" />
              )}
              {formatDistanceToNow(template.updatedAt) === "less than a minute"
                ? "just now"
                : `${formatDistanceToNow(template.updatedAt)} ago`}
            </div>
          </div>
        </div>

        <div className="z-50 mx-auto mb-4 mt-4 flex w-full flex-col p-4 sm:w-[700px]">
          <div className="flex items-center gap-4">
            <label className="block w-[80px] text-sm text-muted-foreground">
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onBlur={() => {
                if (subject === template.subject || !subject) {
                  return;
                }
                update.mutate(
                  { data: { templateId: template.id, subject } },
                  {
                    onError: (error) => {
                      toast.error(`${error.message}. Reverting changes.`);
                      setSubject(template.subject);
                    },
                  },
                );
              }}
              className="mt-1 block w-full border-b border-transparent bg-transparent py-1 text-sm outline-none focus:border-border"
            />
          </div>
        </div>

        <div className="mx-auto w-full rounded-lg bg-gray-50 p-4 sm:w-[700px] sm:p-10">
          <div className="mx-auto w-full sm:w-[600px]">
            <Editor
              initialContent={json}
              onUpdate={(content) => {
                setJson(content.getJSON());
                setIsSaving(true);
                saveContent();
              }}
              variables={["email", "firstName", "lastName"]}
              uploadImage={
                template.imageUploadSupported ? handleFileChange : undefined
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
