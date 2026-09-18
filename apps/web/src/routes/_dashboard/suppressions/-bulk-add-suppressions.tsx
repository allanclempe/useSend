import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import { Label } from "@usesend/ui/src/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usesend/ui/src/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@usesend/ui/src/tabs";
import { Textarea } from "@usesend/ui/src/textarea";

import { suppressionKeys } from "~/queries/suppression";
import { bulkAddSuppressions } from "~/server/functions/suppression";
import { SuppressionReason } from "~/types/db";
import { BULK_SUPPRESSION_LIMIT, parseEmailList } from "./-parse-email-list";

/**
 * Suppress a pasted or uploaded list of addresses.
 *
 * Both tabs feed the same textarea — the file picker reads the file into it
 * rather than holding a second source of truth, which is what the Next.js
 * version did and is why the uploaded text stayed editable there too.
 *
 * `mutation.isPending` replaces the `processing` flag the old component kept
 * beside it; the two could disagree, and did on an error path where
 * `setProcessing(false)` ran twice and the mutation's own state ran once.
 *
 * Self-contained, like `-add-suppression.tsx`: it owns its trigger button.
 */
export default function BulkAddSuppressions() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState("");
  const [reason, setReason] = useState<SuppressionReason>(
    SuppressionReason.MANUAL,
  );
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const { found, valid } = useMemo(() => parseEmailList(emails), [emails]);

  const bulkAdd = useMutation({
    mutationFn: bulkAddSuppressions,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: suppressionKeys.all });
      close();
    },
    onError: (err) => setError(err.message),
  });

  function close() {
    setEmails("");
    setReason(SuppressionReason.MANUAL);
    setError(null);
    setOpen(false);
  }

  function readFile(file: File) {
    if (!file.name.endsWith(".txt") && !file.name.endsWith(".csv")) {
      setError("Please upload a .txt or .csv file");
      return;
    }

    setError(null);

    const reader = new FileReader();
    reader.onload = (event) => setEmails(String(event.target?.result ?? ""));
    reader.readAsText(file);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    const file = event.dataTransfer.files[0];
    if (file) {
      readFile(file);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (valid.length === 0) {
      setError("No valid email addresses found");
      return;
    }

    if (valid.length > BULK_SUPPRESSION_LIMIT) {
      setError(
        `Maximum ${BULK_SUPPRESSION_LIMIT} email addresses allowed per upload`,
      );
      return;
    }

    bulkAdd.mutate({ data: { emails: valid, reason } });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="mr-2 h-4 w-4" />
          Bulk Add
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk Add Email Suppressions</DialogTitle>
          <DialogDescription>
            Add multiple email addresses to the suppression list at once.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs defaultValue="text" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="text">
                <FileText className="mr-2 h-4 w-4" />
                Text Input
              </TabsTrigger>
              <TabsTrigger value="file">
                <Upload className="mr-2 h-4 w-4" />
                File Upload
              </TabsTrigger>
            </TabsList>

            <TabsContent value="text" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="emails">Email Addresses</Label>
                <Textarea
                  id="emails"
                  placeholder={
                    "Enter email addresses separated by commas, semicolons, or new lines:\nexample1@domain.com\nexample2@domain.com"
                  }
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  className="min-h-[120px]"
                  disabled={bulkAdd.isPending}
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
                  onDrop={handleDrop}
                >
                  <input
                    id="file"
                    ref={fileInput}
                    type="file"
                    accept=".txt,.csv"
                    className="hidden"
                    disabled={bulkAdd.isPending}
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
                        disabled={bulkAdd.isPending}
                      >
                        Choose File
                      </Button>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {isDragOver
                        ? "Drop your file here"
                        : "Upload a .txt or .csv file with email addresses or drag and drop here"}
                    </p>
                  </div>
                </div>
                {emails ? (
                  <Textarea
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    className="min-h-[120px]"
                    disabled={bulkAdd.isPending}
                  />
                ) : null}
              </div>
            </TabsContent>
          </Tabs>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason</Label>
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as SuppressionReason)}
              disabled={bulkAdd.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SuppressionReason.MANUAL}>Manual</SelectItem>
                <SelectItem value={SuppressionReason.HARD_BOUNCE}>
                  Hard Bounce
                </SelectItem>
                <SelectItem value={SuppressionReason.COMPLAINT}>
                  Complaint
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {found.length > 0 ? (
            <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              <div>Found {found.length} email addresses</div>
              <div>Valid: {valid.length}</div>
              {valid.length !== found.length ? (
                <div className="text-yellow">
                  Invalid: {found.length - valid.length}
                </div>
              ) : null}
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
              disabled={bulkAdd.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={bulkAdd.isPending || valid.length === 0}
            >
              {bulkAdd.isPending
                ? "Adding..."
                : `Add ${valid.length} Suppressions`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
