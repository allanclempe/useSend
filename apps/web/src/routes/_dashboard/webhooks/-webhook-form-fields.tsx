import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { Button } from "@usesend/ui/src/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@usesend/ui/src/dropdown-menu";
import {
  ContactEvents,
  DomainEvents,
  EmailEvents,
  WebhookEvents,
  type WebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";

import { domainQueries } from "~/queries/domain";

/**
 * The two multi-select pickers the create and edit dialogs share.
 *
 * In the Next.js app these were two ~180-line `render` props pasted into both
 * `add-webhook.tsx` and `webhook-update-dialog.tsx`, character for character.
 * They are one component each here, because the selection rules — what "all
 * events" means when you then untick one, what an empty domain list means —
 * are the part a reader has to get right, and there is no version of this
 * where two copies of them stay in step.
 */

const eventGroups: {
  label: string;
  events: readonly WebhookEventType[];
}[] = [
  { label: "Contact events", events: ContactEvents },
  { label: "Domain events", events: DomainEvents },
  { label: "Email events", events: EmailEvents },
];

/**
 * "All events" is stored as an empty `eventTypes` array, which is also how an
 * unfinished form looks, so the flag cannot be derived from the value and
 * travels alongside it.
 */
export function EventTypesPicker({
  selectedEvents,
  allEventsSelected,
  onChange,
}: {
  selectedEvents: WebhookEventType[];
  allEventsSelected: boolean;
  onChange: (events: WebhookEventType[], allEvents: boolean) => void;
}) {
  const selectedCount = allEventsSelected
    ? WebhookEvents.length
    : selectedEvents.length;

  const label =
    selectedCount === 0
      ? "Select events"
      : allEventsSelected
        ? "All events"
        : selectedCount === 1
          ? selectedEvents[0]
          : `${selectedCount} events selected`;

  const isGroupFullySelected = (groupEvents: readonly WebhookEventType[]) => {
    if (allEventsSelected) return true;
    if (selectedEvents.length === 0) return false;
    return groupEvents.every((event) => selectedEvents.includes(event));
  };

  const handleToggleAll = (checked: boolean) => onChange([], checked);

  // Unticking anything while "all events" is on has to expand the shorthand
  // into the concrete list first, or the unticked event would come back.
  const handleToggleGroup = (groupEvents: readonly WebhookEventType[]) => {
    if (allEventsSelected) {
      onChange(
        WebhookEvents.filter((event) => !groupEvents.includes(event)),
        false,
      );
      return;
    }

    const current = new Set(selectedEvents);
    const fullySelected = groupEvents.every((event) => current.has(event));

    if (fullySelected) {
      groupEvents.forEach((event) => current.delete(event));
    } else {
      groupEvents.forEach((event) => current.add(event));
    }

    onChange(Array.from(current), false);
  };

  const handleToggleEvent = (event: WebhookEventType) => {
    if (allEventsSelected) {
      onChange(
        WebhookEvents.filter((candidate) => candidate !== event),
        false,
      );
      return;
    }

    const exists = selectedEvents.includes(event);
    onChange(
      exists
        ? selectedEvents.filter((candidate) => candidate !== event)
        : [...selectedEvents, event],
      false,
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="mt-3 inline-flex w-full items-center justify-between"
        >
          <span className="truncate text-left text-sm">{label}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="h-[30vh] w-[var(--radix-dropdown-menu-trigger-width)]">
        <div className="space-y-3">
          <DropdownMenuCheckboxItem
            checked={allEventsSelected}
            onCheckedChange={(checked) => handleToggleAll(Boolean(checked))}
            onSelect={(event) => event.preventDefault()}
            className="mb-2 px-2 font-medium"
          >
            All events
          </DropdownMenuCheckboxItem>
          {eventGroups.map((group) => (
            <div key={group.label}>
              <DropdownMenuCheckboxItem
                checked={isGroupFullySelected(group.events)}
                onCheckedChange={() => handleToggleGroup(group.events)}
                onSelect={(event) => event.preventDefault()}
                className="px-2 text-xs font-semibold text-muted-foreground"
              >
                {group.label}
              </DropdownMenuCheckboxItem>
              {group.events.map((event) => (
                <DropdownMenuCheckboxItem
                  key={event}
                  checked={allEventsSelected || selectedEvents.includes(event)}
                  onCheckedChange={() => handleToggleEvent(event)}
                  onSelect={(menuEvent) => menuEvent.preventDefault()}
                  className="pl-3 pr-2 font-mono"
                >
                  {event}
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * An empty domain list means every domain, present and future — which is why
 * "All domains" is a state of its own rather than "every box ticked".
 */
export function DomainsPicker({
  selectedDomainIds,
  onChange,
}: {
  selectedDomainIds: number[];
  onChange: (domainIds: number[]) => void;
}) {
  const domainsQuery = useQuery(domainQueries.list());

  const selectedDomains =
    domainsQuery.data?.filter((domain) =>
      selectedDomainIds.includes(domain.id),
    ) ?? [];

  const label =
    selectedDomainIds.length === 0
      ? "All domains"
      : selectedDomainIds.length === 1
        ? (selectedDomains[0]?.name ?? "1 domain selected")
        : `${selectedDomainIds.length} domains selected`;

  const handleToggleDomain = (domainId: number) => {
    const exists = selectedDomainIds.includes(domainId);
    onChange(
      exists
        ? selectedDomainIds.filter((id) => id !== domainId)
        : [...selectedDomainIds, domainId],
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="mt-3 inline-flex w-full items-center justify-between"
        >
          <span className="truncate text-left text-sm">{label}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[30vh] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
        <div className="space-y-3">
          <DropdownMenuCheckboxItem
            checked={selectedDomainIds.length === 0}
            onCheckedChange={() => onChange([])}
            onSelect={(event) => event.preventDefault()}
            className="mb-2 px-2 font-medium"
          >
            All domains
          </DropdownMenuCheckboxItem>
          {domainsQuery.data?.map((domain) => (
            <DropdownMenuCheckboxItem
              key={domain.id}
              checked={selectedDomainIds.includes(domain.id)}
              onCheckedChange={() => handleToggleDomain(domain.id)}
              onSelect={(event) => event.preventDefault()}
              className="pl-3 pr-2"
            >
              {domain.name}
            </DropdownMenuCheckboxItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
