import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/server/db";
import { getRedis } from "~/server/redis";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
  resetRedis,
} from "~/test/integration/helpers";

const { mockSendTeamInviteEmail, mockCheckTeamMemberLimit } = vi.hoisted(() => ({
  mockSendTeamInviteEmail: vi.fn(),
  mockCheckTeamMemberLimit: vi.fn(),
}));

vi.mock("~/server/mailer", () => ({
  sendTeamInviteEmail: mockSendTeamInviteEmail,
  sendMail: vi.fn(),
}));

vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkTeamMemberLimit: mockCheckTeamMemberLimit },
}));

import { TeamService } from "~/server/service/team-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

async function makeUser(email: string) {
  return db.user.create({ data: { email, name: email } });
}

describeIntegration("team-service", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    vi.clearAllMocks();
    mockCheckTeamMemberLimit.mockResolvedValue({ isLimitReached: false });
    mockSendTeamInviteEmail.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("creates a team and its owning admin together", async () => {
    const user = await makeUser("owner@example.com");

    const team = await TeamService.createTeam(user.id, "acme");

    expect(team?.name).toBe("acme");

    // Prisma did this as one nested create; the port uses a transaction, so a
    // team must never exist without its admin.
    const members = await db.teamUser.findMany({
      where: { teamId: team!.id },
    });
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(user.id);
    expect(members[0]?.role).toBe("ADMIN");
  });

  it("does not create a second team for the same user", async () => {
    const user = await makeUser("twice@example.com");
    await TeamService.createTeam(user.id, "first");

    const second = await TeamService.createTeam(user.id, "second");

    expect(second).toBeUndefined();
    expect(await db.team.count()).toBe(1);
  });

  it("returns a user's teams with only their own membership", async () => {
    const owner = await makeUser("a@example.com");
    const other = await makeUser("b@example.com");
    const team = await TeamService.createTeam(owner.id, "shared");
    await db.teamUser.create({
      data: { teamId: team!.id, userId: other.id, role: "MEMBER" },
    });

    const teams = await TeamService.getUserTeams(owner.id);

    expect(teams).toHaveLength(1);
    expect(teams[0]?.name).toBe("shared");
    // Prisma filtered the nested teamUsers to the requesting user.
    expect(teams[0]?.teamUsers).toHaveLength(1);
    expect(teams[0]?.teamUsers[0]?.userId).toBe(owner.id);
  });

  it("returns team users with their user record attached", async () => {
    const owner = await makeUser("withuser@example.com");
    const team = await TeamService.createTeam(owner.id, "joined");

    const members = await TeamService.getTeamUsers(team!.id);

    expect(members).toHaveLength(1);
    expect(members[0]?.user.email).toBe("withuser@example.com");
  });

  it("caches a team and invalidates it", async () => {
    const owner = await makeUser("cache@example.com");
    const team = await TeamService.createTeam(owner.id, "cached");

    const cached = await TeamService.getTeamCached(team!.id);
    expect(cached.name).toBe("cached");

    await TeamService.updateTeam(team!.id, { name: "renamed" });
    const afterUpdate = await TeamService.getTeamCached(team!.id);
    expect(afterUpdate.name).toBe("renamed");

    await TeamService.invalidateTeamCache(team!.id);
    expect(await getRedis().get(`team:${team!.id}`)).toBeNull();
  });

  it("bumps updatedAt when updating a team", async () => {
    const owner = await makeUser("stamp@example.com");
    const team = await TeamService.createTeam(owner.id, "stamped");
    const before = team!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await TeamService.updateTeam(team!.id, { name: "bumped" });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("creates and lists team invites", async () => {
    const owner = await makeUser("inviter@example.com");
    const team = await TeamService.createTeam(owner.id, "inviting");

    const invite = await TeamService.createTeamInvite(
      team!.id,
      "invitee@example.com",
      "MEMBER",
      "inviting",
    );

    expect(invite.email).toBe("invitee@example.com");
    expect(invite.id).toMatch(/^[0-9a-z]{24}$/);
    expect(mockSendTeamInviteEmail).toHaveBeenCalledTimes(1);

    const invites = await TeamService.getTeamInvites(team!.id);
    expect(invites).toHaveLength(1);
  });

  it("refuses to invite a user who already belongs to a team", async () => {
    const owner = await makeUser("owner2@example.com");
    const taken = await makeUser("taken@example.com");
    const team = await TeamService.createTeam(owner.id, "t1");

    await db.teamUser.create({
      data: { teamId: team!.id, userId: taken.id, role: "MEMBER" },
    });

    await expect(
      TeamService.createTeamInvite(
        team!.id,
        "taken@example.com",
        "MEMBER",
        "t1",
      ),
    ).rejects.toThrow("already part of a team");
  });

  it("deletes an invite by id", async () => {
    const owner = await makeUser("del@example.com");
    const team = await TeamService.createTeam(owner.id, "deleting");
    const invite = await TeamService.createTeamInvite(
      team!.id,
      "gone@example.com",
      "MEMBER",
      "deleting",
    );

    const deleted = await TeamService.deleteTeamInvite(team!.id, invite.id);

    expect(deleted.id).toBe(invite.id);
    expect(await TeamService.getTeamInvites(team!.id)).toHaveLength(0);
  });

  it("throws when deleting a missing invite", async () => {
    const owner = await makeUser("noinvite@example.com");
    const team = await TeamService.createTeam(owner.id, "empty");

    await expect(
      TeamService.deleteTeamInvite(team!.id, "nope"),
    ).rejects.toThrow("Invite not found");
  });

  it("will not touch another team's invite", async () => {
    const ownerA = await makeUser("a-owner@example.com");
    const ownerB = await makeUser("b-owner@example.com");
    const teamA = await TeamService.createTeam(ownerA.id, "A");
    const teamB = await TeamService.createTeam(ownerB.id, "B");

    const inviteB = await TeamService.createTeamInvite(
      teamB!.id,
      "target@example.com",
      "MEMBER",
      "B",
    );
    mockSendTeamInviteEmail.mockClear();

    // Both reads are scoped by teamId, so team A simply cannot see it. This is
    // the enforcement behind the resendTeamInvite authorization test.
    await expect(
      TeamService.resendTeamInvite(teamA!.id, inviteB.id, "A"),
    ).rejects.toThrow("Invite not found");

    await expect(
      TeamService.deleteTeamInvite(teamA!.id, inviteB.id),
    ).rejects.toThrow("Invite not found");

    expect(mockSendTeamInviteEmail).not.toHaveBeenCalled();
    expect(await TeamService.getTeamInvites(teamB!.id)).toHaveLength(1);
  });

  it("refuses to demote the last admin", async () => {
    const owner = await makeUser("lastadmin@example.com");
    const team = await TeamService.createTeam(owner.id, "solo");

    await expect(
      TeamService.updateTeamUserRole(team!.id, String(owner.id), "MEMBER"),
    ).rejects.toThrow("Need at least one admin");
  });

  it("promotes a member when another admin exists", async () => {
    const owner = await makeUser("admin1@example.com");
    const member = await makeUser("member1@example.com");
    const team = await TeamService.createTeam(owner.id, "two");
    await db.teamUser.create({
      data: { teamId: team!.id, userId: member.id, role: "MEMBER" },
    });

    const updated = await TeamService.updateTeamUserRole(
      team!.id,
      String(member.id),
      "ADMIN",
    );

    expect(updated.role).toBe("ADMIN");
  });

  it("refuses to remove the last admin", async () => {
    const owner = await makeUser("onlyadmin@example.com");
    const team = await TeamService.createTeam(owner.id, "alone");

    await expect(
      TeamService.deleteTeamUser(team!.id, String(owner.id), "ADMIN", owner.id),
    ).rejects.toThrow("Need at least one admin");
  });

  it("removes a member and keeps the team", async () => {
    const owner = await makeUser("keep@example.com");
    const member = await makeUser("leaving@example.com");
    const team = await TeamService.createTeam(owner.id, "shrinking");
    await db.teamUser.create({
      data: { teamId: team!.id, userId: member.id, role: "MEMBER" },
    });

    const deleted = await TeamService.deleteTeamUser(
      team!.id,
      String(member.id),
      "ADMIN",
      owner.id,
    );

    expect(deleted.userId).toBe(member.id);
    expect(await TeamService.getTeamUsers(team!.id)).toHaveLength(1);
  });

  it("throws for an unknown team member", async () => {
    const owner = await makeUser("unknown@example.com");
    const team = await TeamService.createTeam(owner.id, "unknown");

    await expect(
      TeamService.updateTeamUserRole(team!.id, "999999", "ADMIN"),
    ).rejects.toThrow("Team member not found");
  });
});
