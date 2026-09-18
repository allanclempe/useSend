import { queryOptions } from "@tanstack/react-query";

import { getInvite, getUserInvites } from "~/server/functions/invitation";

/**
 * Query keys and options for team invites (#9).
 *
 * `userInvites` takes an optional invite id and it is part of the key: with
 * one it answers "is this link still good", without it "what am I invited to".
 * Different questions, and the join page asks both.
 */

export const invitationKeys = {
  all: ["invitation"] as const,
  userInvites: () => [...invitationKeys.all, "userInvites"] as const,
  userInvitesFor: (inviteId?: string | null) =>
    [...invitationKeys.userInvites(), { inviteId: inviteId ?? null }] as const,
  details: () => [...invitationKeys.all, "detail"] as const,
  detail: (inviteId: string) =>
    [...invitationKeys.details(), inviteId] as const,
};

export const invitationQueries = {
  userInvites: (inviteId?: string | null) =>
    queryOptions({
      queryKey: invitationKeys.userInvitesFor(inviteId),
      queryFn: () => getUserInvites({ data: { inviteId } }),
    }),
  detail: (inviteId: string) =>
    queryOptions({
      queryKey: invitationKeys.detail(inviteId),
      queryFn: () => getInvite({ data: { inviteId } }),
    }),
};
