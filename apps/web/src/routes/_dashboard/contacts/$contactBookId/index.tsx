import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import EmojiPicker, { Theme } from "emoji-picker-react";
import {
  Calendar,
  ChevronRight,
  Clock,
  Edit,
  Hash,
  MailX,
  Megaphone,
  MoreVertical,
  Plus,
  Shield,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { useTheme } from "@usesend/ui";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@usesend/ui/src/breadcrumb";
import { Button } from "@usesend/ui/src/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usesend/ui/src/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@usesend/ui/src/popover";
import { Switch } from "@usesend/ui/src/switch";
import { TextWithCopyButton } from "@usesend/ui/src/text-with-copy";

import { contactKeys, contactQueries } from "~/queries/contacts";
import {
  getContactBookDetails,
  updateContactBook,
} from "~/server/functions/contacts";
import DeleteContactBook from "../-delete-contact-book";
import EditContactBook from "../-edit-contact-book";
import AddContact from "./-add-contact";
import BulkUploadContacts from "./-bulk-upload-contacts";
import ContactList from "./-contact-list";

/**
 * `/contacts/$contactBookId`.
 *
 * The three search params belong to the contact list below, not to this
 * header, but they are declared here because `validateSearch` is a property of
 * the route and the list is not one. Their names — `page`, `status`, `search`
 * — are the ones the Next.js page wrote, and they are in people's bookmarks,
 * so they are preserved exactly, including `status`'s capitalised
 * "Subscribed" / "Unsubscribed" spelling.
 *
 * `.catch()` on `status` is deliberate: a hand-edited or stale link with a
 * value we no longer recognise should show the unfiltered list, not a router
 * error page.
 */
const searchSchema = z.object({
  page: z.number().int().min(1).optional().catch(undefined),
  status: z.enum(["Subscribed", "Unsubscribed"]).optional().catch(undefined),
  search: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_dashboard/contacts/$contactBookId/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(
        contactQueries.bookDetail(params.contactBookId),
      ),
      context.queryClient.ensureQueryData(
        contactQueries.list(params.contactBookId, {
          page: deps.page ?? 1,
          search: deps.search,
          subscribed: subscribedFromStatus(deps.status),
        }),
      ),
    ]),
  component: ContactBookPage,
});

/**
 * `inferRouterOutputs` is gone with tRPC; the server function's own return
 * type is the replacement, and it is the only place the shape is written down.
 */
type ContactBookDetails = Awaited<ReturnType<typeof getContactBookDetails>>;

/** "Subscribed" / "Unsubscribed" / nothing → the tri-state the query takes. */
export function subscribedFromStatus(status?: "Subscribed" | "Unsubscribed") {
  if (status === "Subscribed") return true;
  if (status === "Unsubscribed") return false;
  return undefined;
}

function ContactBookPage() {
  const { contactBookId } = Route.useParams();
  const { theme } = useTheme();
  const queryClient = useQueryClient();

  const contactBookQuery = useQuery(contactQueries.bookDetail(contactBookId));

  /**
   * The emoji and the double opt-in switch are both "click and it is done"
   * controls with no form around them, so they are updated in place first and
   * reconciled afterwards. Without that the switch visibly snaps back to its
   * old position for the length of the round trip.
   */
  const update = useMutation({
    mutationFn: updateContactBook,
    onMutate: async ({ data }) => {
      await queryClient.cancelQueries({
        queryKey: contactKeys.bookDetail(contactBookId),
      });

      queryClient.setQueryData(
        contactKeys.bookDetail(contactBookId),
        (old: ContactBookDetails | undefined) =>
          old ? { ...old, ...data } : old,
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: contactKeys.bookDetail(contactBookId),
      }),
  });

  const contactBook = contactBookQuery.data;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/contacts" className="text-xl">
                    Contact books
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="text-xl" />
              <BreadcrumbItem>
                <BreadcrumbPage className="text-xl">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            className="p-0 text-lg hover:bg-transparent"
                            type="button"
                          >
                            {contactBook?.emoji}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-full rounded-none border-0 !bg-transparent !p-0 shadow-none drop-shadow-md">
                          <EmojiPicker
                            onEmojiClick={(emojiObject) =>
                              update.mutate({
                                data: {
                                  contactBookId,
                                  emoji: emojiObject.emoji,
                                },
                              })
                            }
                            theme={
                              theme === "system"
                                ? Theme.AUTO
                                : theme === "dark"
                                  ? Theme.DARK
                                  : Theme.LIGHT
                            }
                          />
                        </PopoverContent>
                      </Popover>
                    </span>
                    <span className="text-xl">{contactBook?.name}</span>
                  </div>
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <ContactBookActions
          contactBookId={contactBookId}
          contactBookName={contactBook?.name}
          contactBookVariables={contactBook?.variables}
        />
      </div>

      <div className="mt-10">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-sm font-medium">Metrics</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  Total Contacts
                </span>
                <span className="font-mono text-lg font-semibold">
                  {contactBook?.totalContacts !== undefined
                    ? contactBook.totalContacts.toLocaleString()
                    : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MailX className="h-3.5 w-3.5" />
                  Unsubscribed
                </span>
                <span className="font-mono text-lg font-semibold text-destructive">
                  {contactBook?.unsubscribedContacts !== undefined
                    ? contactBook.unsubscribedContacts.toLocaleString()
                    : "--"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-sm font-medium">Details</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Contact book ID</p>
                <TextWithCopyButton
                  value={contactBookId}
                  alwaysShowCopy
                  className="w-full rounded bg-muted px-2 py-1 font-mono text-sm"
                />
              </div>
              <div className="space-y-1">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3" />
                  Created
                </p>
                <p className="text-sm">
                  {contactBook?.createdAt
                    ? formatDistanceToNow(new Date(contactBook.createdAt), {
                        addSuffix: true,
                      })
                    : "--"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Variables</p>
                <div className="flex flex-wrap gap-1">
                  {(contactBook?.variables ?? []).length > 0 ? (
                    contactBook?.variables.map((variable) => (
                      <span
                        key={variable}
                        className="rounded bg-muted px-2 py-0.5 font-mono text-xs"
                      >
                        {variable}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">--</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <Megaphone className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-sm font-medium">
                  Recent Campaigns
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {!contactBookQuery.isLoading &&
              contactBook?.campaigns.length === 0 ? (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  No campaigns yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {contactBook?.campaigns.slice(0, 5).map((campaign) => (
                    <Link
                      key={campaign.id}
                      to="/campaigns/$campaignId"
                      params={{ campaignId: campaign.id }}
                      className="group flex items-center justify-between rounded-lg p-2 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Megaphone className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">
                          {campaign.name}
                        </span>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(campaign.createdAt), {
                            addSuffix: true,
                          })}
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </Link>
                  ))}
                  {(contactBook?.campaigns.length || 0) > 5 && (
                    <Link
                      to="/campaigns"
                      className="flex items-center justify-center p-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      View all campaigns
                    </Link>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-muted p-2">
                  <Shield className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-base font-medium">
                    Double Opt-in
                  </CardTitle>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Require email confirmation for new contacts
                  </p>
                </div>
              </div>
              <Switch
                checked={contactBook?.doubleOptInEnabled ?? false}
                onCheckedChange={(checked) =>
                  update.mutate({
                    data: { contactBookId, doubleOptInEnabled: checked },
                  })
                }
                className="data-[state=checked]:bg-green-500"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-4">
              <p className="text-sm text-muted-foreground">
                {contactBook?.doubleOptInEnabled
                  ? "New contacts will receive a confirmation email before being added to this list."
                  : "New contacts will be immediately added to this list without confirmation."}
              </p>
              <Button asChild variant="outline" size="sm">
                <Link
                  to="/contacts/$contactBookId/double-opt-in"
                  params={{ contactBookId }}
                >
                  {contactBook?.doubleOptInEnabled
                    ? "Edit confirmation email"
                    : "Preview confirmation email"}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-10">
        <ContactList
          contactBookId={contactBookId}
          contactBookName={contactBook?.name}
          doubleOptInEnabled={contactBook?.doubleOptInEnabled}
          contactBookVariables={contactBook?.variables}
        />
      </div>
    </div>
  );
}

/**
 * The actions menu.
 *
 * Every entry opens a dialog that is rendered here rather than inside the
 * popover, because the popover closes on click and a dialog unmounted mid-open
 * never appears.
 */
function ContactBookActions({
  contactBookId,
  contactBookName,
  contactBookVariables,
}: {
  contactBookId: string;
  contactBookName?: string;
  contactBookVariables?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isBulkUploadOpen, setIsBulkUploadOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="default" className="gap-1">
            <MoreVertical className="-ml-2 h-4" />
            Actions
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 rounded-xl p-1" align="end">
          <div className="flex flex-col">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start rounded-lg hover:bg-accent"
              onClick={() => {
                setOpen(false);
                setIsAddOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add contacts
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start rounded-lg hover:bg-accent"
              onClick={() => {
                setOpen(false);
                setIsBulkUploadOpen(true);
              }}
            >
              <Upload className="mr-2 h-4 w-4" />
              Bulk upload
            </Button>
            {contactBookName ? (
              <Button
                variant="ghost"
                size="sm"
                className="justify-start rounded-lg hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  setIsEditOpen(true);
                }}
              >
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            ) : null}
            {contactBookName ? (
              <Button
                variant="ghost"
                size="sm"
                className="justify-start rounded-lg text-red/80 hover:bg-accent hover:text-red"
                onClick={() => {
                  setOpen(false);
                  setIsDeleteOpen(true);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      <AddContact
        contactBookId={contactBookId}
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
      />
      <BulkUploadContacts
        contactBookId={contactBookId}
        contactBookVariables={contactBookVariables}
        open={isBulkUploadOpen}
        onOpenChange={setIsBulkUploadOpen}
      />
      {contactBookName ? (
        <EditContactBook
          contactBook={{
            id: contactBookId,
            name: contactBookName,
            variables: contactBookVariables,
          }}
          open={isEditOpen}
          onOpenChange={setIsEditOpen}
          onSuccess={() =>
            queryClient.invalidateQueries({
              queryKey: contactKeys.bookDetail(contactBookId),
            })
          }
        />
      ) : null}
      {contactBookName ? (
        <DeleteContactBook
          contactBook={{ id: contactBookId, name: contactBookName }}
          open={isDeleteOpen}
          onOpenChange={setIsDeleteOpen}
          onSuccess={async () => {
            await navigate({ to: "/contacts" });
          }}
        />
      ) : null}
    </>
  );
}
