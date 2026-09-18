import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as chrono from "chrono-node";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@usesend/ui/src/button";
import { Calendar } from "@usesend/ui/src/calendar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import { Input } from "@usesend/ui/src/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@usesend/ui/src/popover";
import { toast } from "@usesend/ui/src/toaster";

import { campaignKeys } from "~/queries/campaign";
import { scheduleCampaign } from "~/server/functions/campaign";

const INPUT_FORMAT = "yyyy-MM-dd HH:mm";
const SLOT_MINUTES = 15;

/**
 * Pick when a campaign goes out, in words or from a calendar.
 *
 * The text field is parsed by chrono, so "tomorrow 9am" works, but **only a
 * `Date` is ever sent** -- the server is never asked to interpret free text.
 * The two inputs stay in step in one direction each: typing sets the date,
 * picking from the calendar or the time list rewrites the text.
 *
 * "Send Now" is a two-step confirm in place rather than a second dialog. It is
 * the one irreversible button on the page.
 */
export const ScheduleCampaign: React.FC<{
  campaign: { id: string; scheduledAt?: Date | null };
  onScheduled?: () => void;
}> = ({ campaign, onScheduled }) => {
  const queryClient = useQueryClient();
  const dialogContentRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [scheduleInput, setScheduleInput] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [isConfirmNow, setIsConfirmNow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduledAtTimestamp = campaign.scheduledAt
    ? new Date(campaign.scheduledAt).getTime()
    : null;

  // Re-seeded each time it opens, so reopening after a change shows what is
  // actually scheduled rather than what was typed and abandoned last time.
  useEffect(() => {
    if (!open) {
      return;
    }

    if (scheduledAtTimestamp === null) {
      setSelectedDate(new Date());
      setScheduleInput("");
      return;
    }

    const scheduled = new Date(scheduledAtTimestamp);
    setSelectedDate(scheduled);
    setScheduleInput(format(scheduled, INPUT_FORMAT));
  }, [open, scheduledAtTimestamp]);

  const schedule = useMutation({
    mutationFn: scheduleCampaign,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
      setOpen(false);
      setScheduleInput("");
      setSelectedDate(null);
      setIsConfirmNow(false);
      setError(null);
      toast.success("Campaign scheduled");
      onScheduled?.();
    },
    onError: (err) => setError(err.message || "Failed to schedule campaign"),
  });

  /** Every quarter hour of a day, for the list beside the calendar. */
  const timeOptions = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);

    return Array.from(
      { length: (24 * 60) / SLOT_MINUTES },
      (_unused, index) => {
        const minutes = index * SLOT_MINUTES;
        const slot = new Date(base);
        slot.setMinutes(minutes);
        return { minutes, label: format(slot, "h:mm a") };
      },
    );
  }, []);

  function commit(next: Date) {
    setSelectedDate(next);
    setScheduleInput(format(next, INPUT_FORMAT));
  }

  function setDatePreservingTime(dateOnly: Date) {
    const current = selectedDate ?? new Date();
    const next = new Date(dateOnly);
    next.setHours(current.getHours(), current.getMinutes(), 0, 0);
    commit(next);
  }

  function setTimePreservingDate(minutesFromMidnight: number) {
    const next = new Date(selectedDate ?? new Date());
    next.setHours(
      Math.floor(minutesFromMidnight / 60),
      minutesFromMidnight % 60,
      0,
      0,
    );
    commit(next);
  }

  function onScheduleInputChange(value: string) {
    setScheduleInput(value);
    setError(null);
    setSelectedDate(chrono.parseDate(value) ?? new Date());
  }

  function onDialogSchedule() {
    const parsed = selectedDate ?? chrono.parseDate(scheduleInput);

    if (!parsed) {
      setError("Invalid date and time");
      return;
    }

    setError(null);
    schedule.mutate({ data: { campaignId: campaign.id, scheduledAt: parsed } });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          setError(null);
          setIsConfirmNow(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>Schedule Campaign</Button>
      </DialogTrigger>
      <DialogContent ref={dialogContentRef}>
        <DialogHeader>
          <DialogTitle>Schedule Campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-8 py-2">
          <div>
            <label htmlFor="scheduledAt" className="mb-2 block">
              Schedule at
            </label>
            <div className="relative">
              <Input
                id="scheduledAt"
                placeholder="e.g., tomorrow 9am, next monday 10:30"
                value={scheduleInput}
                onChange={(e) => onScheduleInputChange(e.target.value)}
              />
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Open date picker"
                  >
                    <CalendarIcon className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[420px]"
                  align="end"
                  container={dialogContentRef.current}
                >
                  <label className="mb-2 block text-sm">Pick date & time</label>
                  <div className="flex items-start gap-4">
                    <Calendar
                      mode="single"
                      selected={selectedDate ?? new Date()}
                      onSelect={(picked) => {
                        if (picked) {
                          setDatePreservingTime(picked);
                        }
                      }}
                      className="h-[300px] w-[250px] shrink-0 rounded-md border font-mono"
                    />
                    <div
                      className="no-scrollbar h-[300px] min-h-0 w-[140px] overflow-y-auto overscroll-contain rounded-md border p-1 font-mono"
                      // The dialog scrolls too; without this the wheel moves
                      // both and the time list jumps away from the cursor.
                      onWheelCapture={(e) => e.stopPropagation()}
                      onTouchMoveCapture={(e) => e.stopPropagation()}
                    >
                      {timeOptions.map((option) => {
                        const isActive = selectedDate
                          ? selectedDate.getHours() * 60 +
                              selectedDate.getMinutes() ===
                            option.minutes
                          : false;

                        return (
                          <button
                            key={option.minutes}
                            type="button"
                            onClick={() =>
                              setTimePreservingDate(option.minutes)
                            }
                            className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground ${
                              isActive ? "bg-accent text-accent-foreground" : ""
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="mt-4 rounded border border-border p-2 font-mono text-sm text-primary">
              {selectedDate
                ? format(selectedDate, "MMMM do, h:mm a")
                : "No date selected"}
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-4">
            {isConfirmNow ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Are you sure you want to send this campaign now?
                </span>
                <Button
                  size="sm"
                  disabled={schedule.isPending}
                  onClick={() =>
                    schedule.mutate({
                      data: {
                        campaignId: campaign.id,
                        scheduledAt: new Date(),
                      },
                    })
                  }
                >
                  Yes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsConfirmNow(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={schedule.isPending}
                  onClick={() => setIsConfirmNow(true)}
                >
                  Send Now
                </Button>
                <Button
                  className="w-[130px]"
                  onClick={onDialogSchedule}
                  isLoading={schedule.isPending}
                  showSpinner
                >
                  {schedule.isPending ? "Scheduling" : "Schedule"}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ScheduleCampaign;
