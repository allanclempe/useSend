import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Editor } from "@usesend/email-editor";
import { formatDistanceToNow } from "date-fns";
import { useMemo, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@usesend/ui/src/accordion";
import { Input } from "@usesend/ui/src/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import { Spinner } from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { getCampaignEditorVariables } from "~/lib/constants/campaign";
import { campaignKeys } from "~/queries/campaign";
import { contactQueries } from "~/queries/contacts";
import type { getCampaign } from "~/server/functions/campaign";
import {
  generateImagePresignedUrl,
  updateCampaign,
} from "~/server/functions/campaign";
import { CampaignField } from "./-campaign-field";
import { ScheduleCampaign } from "./-schedule-campaign";

const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;

type CampaignDetail = Awaited<ReturnType<typeof getCampaign>>;

/**
 * Compose a campaign: its headers, its recipients and its body.
 *
 * Everything saves on its own trigger -- the header fields on blur, the
 * document a second after the last keystroke -- so there is no save button and
 * nothing to lose by navigating away.
 *
 * **A campaign created through the API is read-only here.** Its content is
 * owned by whatever sent it, and letting the editor overwrite that would make
 * the API's copy and the dashboard's disagree with no way to tell which is
 * current.
 */
export function CampaignEditor({ campaign }: { campaign: CampaignDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const isApiCampaign = campaign.isApi;

  const contactBooksQuery = useQuery(contactQueries.bookList());

  const [json, setJson] = useState<Record<string, unknown> | undefined>(() =>
    campaign.content ? JSON.parse(campaign.content) : undefined,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [contactBookId, setContactBookId] = useState(campaign.contactBookId);

  const update = useMutation({
    mutationFn: updateCampaign,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
      setIsSaving(false);
    },
    onError: () => setIsSaving(false),
  });

  const saveContent = useDebouncedCallback(() => {
    if (isApiCampaign) {
      return;
    }

    update.mutate({
      data: { campaignId: campaign.id, content: JSON.stringify(json) },
    });
  }, 1000);

  /** One header field's save, wired to the shared revert. */
  function saveField(patch: Record<string, unknown>, onError: () => void) {
    update.mutate({ data: { campaignId: campaign.id, ...patch } }, { onError });
  }

  /**
   * Uploads go straight from the browser to R2 with a presigned URL, so the
   * image never passes through the Worker -- which has a request body limit an
   * email banner can exceed.
   */
  async function handleFileChange(file: File) {
    if (file.size > IMAGE_SIZE_LIMIT) {
      throw new Error(
        `File should be less than ${IMAGE_SIZE_LIMIT / 1024 / 1024}MB`,
      );
    }

    const { uploadUrl, imageUrl } = await generateImagePresignedUrl({
      data: { campaignId: campaign.id, name: file.name, type: file.type },
    });

    const response = await fetch(uploadUrl, { method: "PUT", body: file });

    if (!response.ok) {
      throw new Error("Failed to upload file");
    }

    return imageUrl;
  }

  const contactBook = contactBooksQuery.data?.find(
    (book) => book.id === contactBookId,
  );

  // The editor's `{{variables}}` come from the chosen contact book, so the
  // key below remounts it when that changes — TipTap reads its suggestion list
  // once, at construction.
  const editorVariables = useMemo(
    () => getCampaignEditorVariables(contactBook?.variables),
    [contactBook],
  );

  return (
    <div className="container mx-auto p-4">
      <div className="mx-auto">
        <div className="mx-auto mb-4 flex w-[700px] items-center justify-between">
          <Input
            type="text"
            defaultValue={campaign.name}
            disabled={isApiCampaign}
            readOnly={isApiCampaign}
            className="w-[300px] border-0 px-0.5 focus:outline-none focus:ring-0"
            onBlur={(e) => {
              const name = e.target.value;

              if (isApiCampaign || !name || name === campaign.name) {
                return;
              }

              saveField({ name }, () => {
                toast.error("Could not save name. Reverting changes.");
                e.target.value = campaign.name;
              });
            }}
          />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              {isSaving ? (
                <div className="h-2 w-2 rounded-full bg-yellow" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-green" />
              )}
              {formatDistanceToNow(campaign.updatedAt) === "less than a minute"
                ? "just now"
                : `${formatDistanceToNow(campaign.updatedAt)} ago`}
            </div>

            <ScheduleCampaign
              campaign={campaign}
              onScheduled={() =>
                void navigate({
                  to: "/campaigns/$campaignId",
                  params: { campaignId: campaign.id },
                })
              }
            />
          </div>
        </div>

        <Accordion type="single" collapsible>
          <AccordionItem value="headers">
            <div className="z-50 mx-auto mb-12 mt-12 flex w-[700px] flex-col rounded-lg border p-4 shadow">
              <div className="flex items-center gap-4">
                <CampaignField
                  label="Subject"
                  committed={campaign.subject}
                  disabled={isApiCampaign}
                  onSave={(subject, onError) => saveField({ subject }, onError)}
                />
                <AccordionTrigger className="py-0" />
              </div>

              <AccordionContent className="flex flex-col gap-4">
                <div className="mt-4">
                  <CampaignField
                    label="From"
                    committed={campaign.from}
                    placeholder="Friendly name<hello@example.com>"
                    disabled={isApiCampaign}
                    onSave={(from, onError) => saveField({ from }, onError)}
                  />
                </div>
                <CampaignField
                  label="Reply To"
                  committed={campaign.replyTo[0] ?? ""}
                  placeholder="hello@example.com"
                  disabled={isApiCampaign}
                  allowEmpty
                  onSave={(replyTo, onError) =>
                    saveField({ replyTo: replyTo ? [replyTo] : [] }, onError)
                  }
                />
                <CampaignField
                  label="Preview"
                  committed={campaign.previewText ?? ""}
                  disabled={isApiCampaign}
                  onSave={(previewText, onError) =>
                    saveField({ previewText }, onError)
                  }
                />
                <div className="flex items-center gap-2">
                  <label className="block w-[80px] text-sm text-muted-foreground">
                    To
                  </label>
                  {contactBooksQuery.isLoading ? (
                    <Spinner className="h-6 w-6" />
                  ) : (
                    <Select
                      value={contactBookId ?? ""}
                      disabled={isApiCampaign}
                      onValueChange={(value) => {
                        if (isApiCampaign) {
                          return;
                        }

                        setContactBookId(value);
                        saveField({ contactBookId: value }, () =>
                          setContactBookId(campaign.contactBookId),
                        );
                      }}
                    >
                      <SelectTrigger className="w-[300px]">
                        {contactBook
                          ? `${contactBook.emoji} ${contactBook.name}`
                          : "Select a contact book"}
                      </SelectTrigger>
                      <SelectContent>
                        {contactBooksQuery.data?.map((book) => (
                          <SelectItem key={book.id} value={book.id}>
                            {book.emoji} {book.name}{" "}
                            <span className="ml-4 text-xs text-muted-foreground">
                              {book._count.contacts} contacts
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </AccordionContent>
            </div>
          </AccordionItem>
        </Accordion>

        {isApiCampaign ? (
          <p className="text-center text-sm text-muted-foreground">
            Email created from API. Campaign content can only be updated via
            API.
          </p>
        ) : (
          <div className="mx-auto w-[700px] rounded-lg bg-gray-50 p-10">
            <div className="mx-auto w-[600px]">
              <Editor
                key={`campaign-editor-${contactBookId ?? "none"}-${editorVariables.join(",")}`}
                initialContent={json}
                onUpdate={(content) => {
                  setJson(content.getJSON());
                  setIsSaving(true);
                  saveContent();
                }}
                variables={editorVariables}
                variableSuggestionsHelperText={
                  contactBookId
                    ? undefined
                    : "Select the contact book for related variable"
                }
                uploadImage={
                  campaign.imageUploadSupported ? handleFileChange : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CampaignEditor;
