import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Editor } from "@usesend/email-editor";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { Input } from "@usesend/ui/src/input";
import { toast } from "@usesend/ui/src/toaster";

import {
  DEFAULT_DOUBLE_OPT_IN_SUBJECT,
  DOUBLE_OPT_IN_EDITOR_VARIABLES,
  getDefaultDoubleOptInContent,
  hasDoubleOptInUrlPlaceholder,
} from "~/lib/constants/double-opt-in";
import { contactKeys } from "~/queries/contacts";
import type { getContactBookDetails } from "~/server/functions/contacts";
import { updateContactBook } from "~/server/functions/contacts";

const URL_REQUIRED_MESSAGE =
  "Double opt-in email content must include {{doubleOptInUrl}}.";

type ContactBookDetail = Awaited<ReturnType<typeof getContactBookDetails>>;

/**
 * Content that is not valid JSON is a starting document, not an error: the
 * column is nullable and an older row may hold something this editor cannot
 * read, and neither case is worth a broken page.
 */
function parseEditorContent(content: string | null | undefined) {
  if (!content) {
    return getDefaultDoubleOptInContent();
  }

  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return getDefaultDoubleOptInContent();
  }
}

/**
 * The confirmation email a contact book sends before it counts someone as
 * subscribed.
 *
 * Same shape as the template editor -- the two inputs save on blur, the
 * document a second after the last keystroke -- with one extra rule: the
 * document is refused unless it still contains `{{doubleOptInUrl}}`. Without
 * it the email has no confirmation link and every contact stays pending for
 * ever, so the save is cancelled rather than sent, and the toast fires once
 * per run of bad edits rather than once per keystroke.
 */
export function DoubleOptInEditor({
  contactBook,
}: {
  contactBook: ContactBookDetail;
}) {
  const queryClient = useQueryClient();

  const [json, setJson] = useState(() =>
    parseEditorContent(contactBook.doubleOptInContent),
  );
  const [subject, setSubject] = useState(
    contactBook.doubleOptInSubject ?? DEFAULT_DOUBLE_OPT_IN_SUBJECT,
  );
  const [from, setFrom] = useState(contactBook.doubleOptInFrom ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const warnedAboutPlaceholder = useRef(false);

  const update = useMutation({
    mutationFn: updateContactBook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: contactKeys.bookDetail(contactBook.id),
      });
      setIsSaving(false);
    },
    onError: (error) => {
      toast.error(error.message);
      setIsSaving(false);
    },
  });

  const saveContent = useDebouncedCallback((content: string) => {
    update.mutate({
      data: { contactBookId: contactBook.id, doubleOptInContent: content },
    });
  }, 1000);

  return (
    <div className="container mx-auto p-4">
      <div className="mx-auto">
        <div className="mx-auto mb-4 flex w-full items-center justify-between sm:w-[700px]">
          <div className="flex items-center gap-3">
            <Link
              to="/contacts/$contactBookId"
              params={{ contactBookId: contactBook.id }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="text-sm text-muted-foreground">
                Double opt-in email
              </div>
              <div className="text-base font-medium">{contactBook.name}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
            {isSaving ? (
              <div className="h-2 w-2 rounded-full bg-yellow" />
            ) : (
              <div className="h-2 w-2 rounded-full bg-green" />
            )}
            {formatDistanceToNow(contactBook.updatedAt) === "less than a minute"
              ? "just now"
              : `${formatDistanceToNow(contactBook.updatedAt)} ago`}
          </div>
        </div>

        <div className="z-50 mx-auto mb-4 mt-4 flex w-full flex-col rounded-lg border p-4 shadow sm:w-[700px]">
          <div className="flex items-center gap-4">
            <label className="block w-[80px] text-sm text-muted-foreground">
              Subject
            </label>
            <Input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onBlur={() => {
                const next = subject.trim() || DEFAULT_DOUBLE_OPT_IN_SUBJECT;
                const current =
                  contactBook.doubleOptInSubject ??
                  DEFAULT_DOUBLE_OPT_IN_SUBJECT;

                if (next === current) {
                  return;
                }

                setIsSaving(true);
                update.mutate(
                  {
                    data: {
                      contactBookId: contactBook.id,
                      doubleOptInSubject: next,
                    },
                  },
                  { onError: () => setSubject(current) },
                );
              }}
              className="mt-1 block w-full border-b border-transparent bg-transparent py-1 text-sm outline-none focus:border-border"
            />
          </div>
          <div className="mt-4 flex items-center gap-4">
            <label className="block w-[80px] text-sm text-muted-foreground">
              From
            </label>
            <Input
              type="text"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              onBlur={() => {
                const next = from.trim();
                const current = contactBook.doubleOptInFrom ?? "";

                if (next === current) {
                  return;
                }

                setIsSaving(true);
                update.mutate(
                  {
                    data: {
                      contactBookId: contactBook.id,
                      doubleOptInFrom: next || null,
                    },
                  },
                  { onError: () => setFrom(current) },
                );
              }}
              placeholder="Friendly name<hello@example.com>"
              className="mt-1 block w-full border-b border-transparent bg-transparent py-1 text-sm outline-none focus:border-border"
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Use the variable <code>{"{{doubleOptInUrl}}"}</code> for the
            confirmation link.
          </p>
        </div>

        <div className="mx-auto w-full rounded-lg bg-gray-50 p-4 sm:w-[700px] sm:p-10">
          <div className="mx-auto w-full sm:w-[600px]">
            <Editor
              initialContent={json}
              onUpdate={(content) => {
                const next = content.getJSON();
                const serialised = JSON.stringify(next);

                setJson(next);

                if (!hasDoubleOptInUrlPlaceholder(serialised)) {
                  saveContent.cancel();
                  setIsSaving(false);

                  if (!warnedAboutPlaceholder.current) {
                    toast.error(URL_REQUIRED_MESSAGE);
                    warnedAboutPlaceholder.current = true;
                  }

                  return;
                }

                warnedAboutPlaceholder.current = false;
                setIsSaving(true);
                saveContent(serialised);
              }}
              variables={DOUBLE_OPT_IN_EDITOR_VARIABLES}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default DoubleOptInEditor;
