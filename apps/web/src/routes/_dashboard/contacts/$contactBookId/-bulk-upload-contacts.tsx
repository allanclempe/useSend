import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@usesend/ui/src/dialog";
import { Label } from "@usesend/ui/src/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@usesend/ui/src/tabs";
import { Textarea } from "@usesend/ui/src/textarea";
import { toast } from "@usesend/ui/src/toaster";

import { contactKeys } from "~/queries/contacts";
import { addContacts } from "~/server/functions/contacts";
import {
  BULK_CONTACT_LIMIT,
  PREVIEW_ROWS,
  parseContacts,
} from "./-parse-contacts";

/**
 * Upload a contact list, pasted or from a file.
 *
 * The parsing lives in `-parse-contacts.ts` with its own tests; what is left
 * here is the dialog. Both tabs feed the same textarea, so an uploaded file
 * stays editable and the preview table below is the same preview either way.
 *
 * Controlled, like `-add-contact.tsx`, because the page's Actions popover
 * opens it. `addContacts.isPending` is the only "busy" state -- the Next.js
 * component kept a `processing` flag beside the mutation's own and they could
 * disagree on the error path.
 */
export default function BulkUploadContacts({
  contactBookId,
  contactBookVariables,
  open,
  onOpenChange,
}: {
  contactBookId: string;
  contactBookVariables?: Array<string>;
  open: boolean;
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [inputText, setInputText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const parsed = useMemo(
    () => parseContacts(inputText, contactBookVariables ?? []),
    [inputText, contactBookVariables],
  );
  const valid = useMemo(() => parsed.filter((c) => c.isValid), [parsed]);
  const preview = parsed.slice(0, PREVIEW_ROWS);

  const upload = useMutation({
    mutationFn: addContacts,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      close();
      toast.success(result.message);
    },
    onError: (err) => setError(err.message),
  });

  function close() {
    setInputText("");
    setError(null);
    onOpenChange(false);
  }

  function readFile(file: File) {
    if (!file.name.endsWith(".txt") && !file.name.endsWith(".csv")) {
      setError("Please upload a .txt or .csv file");
      return;
    }

    setError(null);

    const reader = new FileReader();
    reader.onload = (event) => setInputText(String(event.target?.result ?? ""));
    reader.readAsText(file);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (valid.length === 0) {
      setError("No valid email addresses found");
      return;
    }

    if (valid.length > BULK_CONTACT_LIMIT) {
      setError(
        `Maximum ${BULK_CONTACT_LIMIT.toLocaleString()} contacts allowed per upload`,
      );
      return;
    }

    upload.mutate({
      data: {
        contactBookId,
        // `isValid` is the dialog's own bookkeeping; the server function's
        // validator has no field for it.
        contacts: valid.map((contact) => ({
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
          subscribed: contact.subscribed,
          properties: contact.properties,
        })),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bulk Upload Contacts</DialogTitle>
          <DialogDescription className="text-sm">
            Upload multiple contacts at once. Cannot change from unsubscribed to
            subscribed via upload
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs defaultValue="text" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="file">
                <Upload className="mr-2 h-4 w-4" />
                File Upload
              </TabsTrigger>
              <TabsTrigger value="text">
                <FileText className="mr-2 h-4 w-4" />
                Text Input
              </TabsTrigger>
            </TabsList>

            <TabsContent value="text" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="contacts">Contacts</Label>
                <Textarea
                  id="contacts"
                  placeholder={
                    "Enter contacts, one per line:\n\njohn@example.com,John,Doe,Yes\njane@example.com,Jane,Smith,No\nbob@example.com\n\nFormat: email,firstName,lastName,subscribed (all fields except email are optional)"
                  }
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  className="min-h-[150px] font-mono text-sm"
                  disabled={upload.isPending}
                />
              </div>
            </TabsContent>

            <TabsContent value="file" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="file">Upload File</Label>
                <div
                  className={`rounded-lg border-2 border-dashed p-6 transition-colors ${
                    isDragOver
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/25"
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);

                    const file = e.dataTransfer.files[0];
                    if (file) {
                      readFile(file);
                    }
                  }}
                >
                  <input
                    id="file"
                    ref={fileInput}
                    type="file"
                    accept=".txt,.csv"
                    className="hidden"
                    disabled={upload.isPending}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        readFile(file);
                      }
                    }}
                  />
                  <div className="text-center">
                    <Upload
                      className={`mx-auto h-12 w-12 ${
                        isDragOver ? "text-primary" : "text-muted-foreground"
                      }`}
                    />
                    <div className="mt-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => fileInput.current?.click()}
                        disabled={upload.isPending}
                      >
                        Choose File
                      </Button>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {isDragOver
                        ? "Drop your file here"
                        : "Upload a .txt or .csv file or drag and drop here"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Format: email,firstName,lastName,subscribed (+ optional
                      custom columns)
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {preview.length > 0 ? (
            <div className="space-y-2">
              <Label>
                Preview (showing {preview.length} of {parsed.length})
              </Label>
              <div className="max-h-[250px] overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead>Email</TableHead>
                      <TableHead>First Name</TableHead>
                      <TableHead>Last Name</TableHead>
                      <TableHead>Subscribed</TableHead>
                      <TableHead className="w-[80px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.map((contact) => (
                      <TableRow key={contact.email}>
                        <TableCell className="font-mono text-sm">
                          {contact.email}
                        </TableCell>
                        <TableCell className="text-sm">
                          {contact.firstName ?? (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {contact.lastName ?? (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {contact.subscribed === undefined ? (
                            <span className="text-muted-foreground">
                              Default
                            </span>
                          ) : contact.subscribed ? (
                            <span className="text-green">Yes</span>
                          ) : (
                            <span className="text-red">No</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {contact.isValid ? (
                            <div className="flex items-center text-green">
                              <Check className="mr-1 h-4 w-4" />
                              <span className="text-xs">Valid</span>
                            </div>
                          ) : (
                            <div className="flex items-center text-red">
                              <X className="mr-1 h-4 w-4" />
                              <span className="text-xs">Invalid</span>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

          {parsed.length > 0 ? (
            <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              <div className="flex gap-4">
                <span>Total: {parsed.length}</span>
                <span className="text-green">Valid: {valid.length}</span>
                {parsed.length > valid.length ? (
                  <span className="text-red">
                    Invalid: {parsed.length - valid.length}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={upload.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={upload.isPending || valid.length === 0}
            >
              {upload.isPending
                ? "Uploading..."
                : `Upload ${valid.length} Contacts`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
