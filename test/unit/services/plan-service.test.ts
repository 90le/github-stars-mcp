import { describe, expect, it } from "vitest";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asUserListId,
} from "../../../src/domain/ids.js";
import type { PlanRequest } from "../../../src/domain/plan.js";
import {
  plannerFixture,
  repositoryFixture,
  userListFixture,
} from "../../support/change-service-fixtures.js";

async function rejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, retryable: false });
}

describe("PlanService", () => {
  it("derives binding, protects IDs, and turns membership add into one complete set", async () => {
    const fixture = plannerFixture();
    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        {
          kind: "unstar",
          repositories: {
            kind: "filter",
            filter: { field: "stargazer_count", op: "lt", value: 100 },
          },
        },
        {
          kind: "list_membership_add",
          repositories: {
            kind: "ids",
            repositoryIds: [fixture.ids.removeRepository],
          },
          lists: [{ kind: "existing", listId: fixture.ids.addList }],
        },
      ],
      protectedRepositoryIds: [fixture.ids.keepRepository],
      protectedListIds: [],
      callerNote: "cleanup",
    });

    expect(result.plan.executable.binding).toEqual(fixture.snapshot.binding);
    expect(result.plan.operations).toMatchObject([
      {
        operationId: "op_000001",
        kind: "unstar",
        repositoryId: fixture.ids.removeRepository,
      },
      {
        operationId: "op_000002",
        kind: "list_membership_set",
        repositoryId: fixture.ids.removeRepository,
        expectedListIds: [fixture.ids.existingList],
        targetLists: [
          { kind: "existing", listId: fixture.ids.addList },
          { kind: "existing", listId: fixture.ids.existingList },
        ],
      },
    ]);
    expect(fixture.storage.getPlan(result.plan.id)).toEqual(result.plan);
    expect(fixture.tracking.savedPlans).toEqual([result.plan]);
    expect(fixture.tracking.transactionCalls).toBe(1);
  });

  it("uses stable local operation IDs and hashes identical executable content identically", async () => {
    const first = plannerFixture();
    const second = plannerFixture();
    const membership = {
      kind: "list_membership_add" as const,
      repositories: {
        kind: "ids" as const,
        repositoryIds: [first.ids.removeRepository],
      },
      lists: [{ kind: "existing" as const, listId: first.ids.addList }],
    };

    const a = await first.service.create({
      ...first.validInput,
      actions: [first.validInput.actions[0]!, membership],
      ttlMinutes: 30,
      callerNote: "first display-only note",
    });
    const b = await second.service.create({
      ...second.validInput,
      actions: [membership, second.validInput.actions[0]!],
      ttlMinutes: 60,
      callerNote: "second display-only note",
    });

    expect(a.plan.id).not.toBe(b.plan.id);
    expect(a.plan.executable).toEqual(b.plan.executable);
    expect(a.plan.hash).toBe(b.plan.hash);
    expect(Object.isFrozen(a.plan)).toBe(true);
    expect(Object.isFrozen(a.plan.executable)).toBe(true);
    expect(Object.isFrozen(a.plan.operations)).toBe(true);
  });

  it("stars stored metadata before assigning Lists to a currently unstarred repository", async () => {
    const unstarred = repositoryFixture({
      repositoryId: asRepositoryId("R_unstarred"),
      repositoryDatabaseId: asRepositoryDatabaseId("8100"),
      name: "unstarred",
      fullName: "acme/unstarred",
      url: "https://github.com/acme/unstarred",
    });
    const targetList = userListFixture({
      listId: asUserListId("UL_target"),
      name: "Target",
      slug: "target",
    });
    const fixture = plannerFixture({
      repositories: [unstarred],
      starredRepositoryIds: [],
      lists: [targetList],
      memberships: [],
    });
    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        {
          kind: "list_membership_add",
          repositories: {
            kind: "ids",
            repositoryIds: [unstarred.repositoryId],
          },
          lists: [{ kind: "existing", listId: targetList.listId }],
        },
        {
          kind: "star",
          repositories: {
            kind: "ids",
            repositoryIds: [unstarred.repositoryId],
          },
        },
      ],
      protectedRepositoryIds: [],
      protectedListIds: [],
    });

    expect(result.plan.operations).toMatchObject([
      {
        operationId: "op_000001",
        kind: "star",
        repositoryId: unstarred.repositoryId,
        before: { starred: false },
      },
      {
        operationId: "op_000002",
        kind: "list_membership_set",
        repositoryId: unstarred.repositoryId,
        dependsOn: ["op_000001"],
      },
    ]);
    expect(result.plan.dependencies).toEqual([
      {
        operationId: "op_000002",
        dependsOnOperationId: "op_000001",
      },
    ]);
  });

  it("pages repository selectors to exhaustion with bounded requests", async () => {
    const repositories = Array.from({ length: 205 }, (_, index) =>
      repositoryFixture({
        repositoryId: asRepositoryId(
          `R_page_${String(index).padStart(3, "0")}`,
        ),
        repositoryDatabaseId: asRepositoryDatabaseId(String(1_000 + index)),
        name: `page-${String(index).padStart(3, "0")}`,
        fullName: `acme/page-${String(index).padStart(3, "0")}`,
        url: `https://github.com/acme/page-${String(index).padStart(3, "0")}`,
      }),
    );
    const fixture = plannerFixture({
      listCoverage: "unavailable",
      repositories,
      lists: [],
      memberships: [],
    });

    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        {
          kind: "unstar",
          repositories: {
            kind: "filter",
            filter: { field: "stargazer_count", op: "gte", value: 0 },
          },
        },
      ],
      protectedRepositoryIds: [],
      protectedListIds: [],
    });

    expect(result.plan.operations).toHaveLength(205);
    expect(fixture.tracking.repositoryQueries).toHaveLength(3);
    expect(
      fixture.tracking.repositoryQueries.map((query) => query.cursor),
    ).toEqual([null, expect.any(String), expect.any(String)]);
    expect(
      fixture.tracking.repositoryQueries.every(
        (query) => query.pageSize === 100,
      ),
    ).toBe(true);
  });

  it("pages List metadata and both membership directions to exhaustion", async () => {
    const lists = Array.from({ length: 206 }, (_, index) =>
      userListFixture({
        listId: asUserListId(`UL_page_${String(index).padStart(3, "0")}`),
        name: `List ${String(index).padStart(3, "0")}`,
        slug: `list-${String(index).padStart(3, "0")}`,
      }),
    );
    const repository = repositoryFixture({
      repositoryId: asRepositoryId("R_member_page"),
      repositoryDatabaseId: asRepositoryDatabaseId("9001"),
      name: "member-page",
      fullName: "acme/member-page",
      url: "https://github.com/acme/member-page",
    });
    const memberships = lists.slice(0, 204).map((list) => ({
      listId: list.listId,
      repositoryId: repository.repositoryId,
    }));
    const fixture = plannerFixture({
      repositories: [repository],
      lists,
      memberships,
    });

    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        {
          kind: "list_membership_add",
          repositories: {
            kind: "ids",
            repositoryIds: [repository.repositoryId],
          },
          lists: [{ kind: "existing", listId: lists[205]!.listId }],
        },
        {
          kind: "list_delete",
          listIds: [lists[204]!.listId],
        },
      ],
      protectedRepositoryIds: [],
      protectedListIds: [],
    });

    expect(result.plan.operations).toHaveLength(2);
    expect(fixture.tracking.listQueries).toHaveLength(3);
    expect(
      fixture.tracking.listQueries.every((query) => query.pageSize === 100),
    ).toBe(true);
    const byRepository = fixture.tracking.membershipQueries.filter(
      (query) => query.selector.kind === "repository",
    );
    const byList = fixture.tracking.membershipQueries.filter(
      (query) => query.selector.kind === "list",
    );
    expect(byRepository).toHaveLength(3);
    expect(byList).toHaveLength(1);
    expect(
      fixture.tracking.membershipQueries.every(
        (query) => query.pageSize === 100,
      ),
    ).toBe(true);
  });

  it.each(["repository", "list"] as const)(
    "rejects a membership page that echoes the wrong %s selector ID",
    async (direction) => {
      const fixture = plannerFixture({
        membershipSelectorMismatch: direction,
      });
      const actions: PlanRequest["actions"] =
        direction === "repository"
          ? [
              {
                kind: "list_membership_add",
                repositories: {
                  kind: "ids",
                  repositoryIds: [fixture.ids.removeRepository],
                },
                lists: [{ kind: "existing", listId: fixture.ids.addList }],
              },
            ]
          : [
              {
                kind: "list_delete",
                listIds: [fixture.ids.addList],
              },
            ];

      await rejection(
        fixture.service.create({
          snapshotId: fixture.snapshot.id,
          actions,
          protectedRepositoryIds: [],
          protectedListIds: [],
        }),
        "STORAGE_ERROR",
      );
      expect(fixture.tracking.membershipQueries.length).toBeGreaterThan(0);
      expect(fixture.tracking.savedPlans).toEqual([]);
      expect(fixture.tracking.transactionCalls).toBe(0);
    },
  );

  it.each(["unavailable", "omitted"] as const)(
    "rejects List work on %s coverage before saving",
    async (listCoverage) => {
      const fixture = plannerFixture({ listCoverage });
      await rejection(
        fixture.service.create({
          snapshotId: fixture.snapshot.id,
          actions: [
            {
              kind: "list_create",
              clientRef: "new",
              name: "New",
              description: null,
              isPrivate: false,
            },
          ],
          protectedRepositoryIds: [],
          protectedListIds: [],
        }),
        "CAPABILITY_UNAVAILABLE",
      );
      expect(fixture.tracking.savedPlans).toEqual([]);
      expect(fixture.tracking.transactionCalls).toBe(0);
    },
  );

  it("allows Star-only work on final non-List coverage", async () => {
    const fixture = plannerFixture({ listCoverage: "omitted" });
    const result = await fixture.service.create(fixture.validInput);
    expect(result.plan.operations).toHaveLength(1);
    expect(result.plan.operations[0]?.preconditions).toEqual([
      { kind: "star_state", expected: true },
    ]);
  });

  it.each(["building", "failed"] as const)(
    "rejects a %s source snapshot before saving",
    async (snapshotStatus) => {
      const fixture = plannerFixture({ snapshotStatus });
      await rejection(
        fixture.service.create(fixture.validInput),
        "STALE_SNAPSHOT",
      );
      expect(fixture.tracking.savedPlans).toEqual([]);
      expect(fixture.tracking.transactionCalls).toBe(0);
    },
  );

  it("rejects missing IDs and conflicting intents without saving", async () => {
    const missing = plannerFixture();
    await rejection(
      missing.service.create({
        ...missing.validInput,
        actions: [
          {
            kind: "unstar",
            repositories: {
              kind: "ids",
              repositoryIds: [asRepositoryId("R_missing")],
            },
          },
        ],
      }),
      "NOT_FOUND",
    );
    expect(missing.tracking.savedPlans).toEqual([]);

    const missingProtection = plannerFixture();
    await rejection(
      missingProtection.service.create({
        ...missingProtection.validInput,
        protectedRepositoryIds: [asRepositoryId("R_missing_protected")],
      }),
      "NOT_FOUND",
    );
    expect(missingProtection.tracking.savedPlans).toEqual([]);

    const conflict = plannerFixture();
    await rejection(
      conflict.service.create({
        ...conflict.validInput,
        actions: [
          {
            kind: "star",
            repositories: {
              kind: "ids",
              repositoryIds: [conflict.ids.removeRepository],
            },
          },
          {
            kind: "unstar",
            repositories: {
              kind: "ids",
              repositoryIds: [conflict.ids.removeRepository],
            },
          },
        ],
      }),
      "VALIDATION_ERROR",
    );
    expect(conflict.tracking.savedPlans).toEqual([]);
  });

  it("removes protected targets while preserving protected memberships", async () => {
    const fixture = plannerFixture();
    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        {
          kind: "list_update",
          listIds: [fixture.ids.existingList, fixture.ids.addList],
          description: "changed",
        },
        {
          kind: "list_delete",
          listIds: [fixture.ids.existingList],
        },
        {
          kind: "list_membership_remove",
          repositories: {
            kind: "ids",
            repositoryIds: [fixture.ids.removeRepository],
          },
          lists: [
            { kind: "existing", listId: fixture.ids.existingList },
            { kind: "existing", listId: fixture.ids.addList },
          ],
        },
      ],
      protectedRepositoryIds: [fixture.ids.keepRepository],
      protectedListIds: [fixture.ids.existingList],
    });

    expect(result.plan.operations).toMatchObject([
      {
        kind: "list_update",
        listId: fixture.ids.addList,
      },
    ]);
    expect(
      result.plan.operations.some(
        (operation) =>
          "listId" in operation &&
          operation.listId === fixture.ids.existingList,
      ),
    ).toBe(false);
    expect(result.plan.warnings.join(" ")).toContain("protected");
  });

  it("collapses duplicates, expands List updates, and coalesces membership deltas", async () => {
    const fixture = plannerFixture();
    const action = {
      kind: "unstar" as const,
      repositories: {
        kind: "ids" as const,
        repositoryIds: [fixture.ids.removeRepository],
      },
    };
    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        action,
        action,
        {
          kind: "list_update",
          listIds: [fixture.ids.addList, fixture.ids.existingList],
          description: "organized",
        },
        {
          kind: "list_membership_add",
          repositories: {
            kind: "ids",
            repositoryIds: [fixture.ids.removeRepository],
          },
          lists: [{ kind: "existing", listId: fixture.ids.addList }],
        },
        {
          kind: "list_membership_remove",
          repositories: {
            kind: "ids",
            repositoryIds: [fixture.ids.removeRepository],
          },
          lists: [{ kind: "existing", listId: fixture.ids.existingList }],
        },
      ],
      protectedRepositoryIds: [],
      protectedListIds: [],
    });

    expect(result.summary).toEqual({
      star: 0,
      unstar: 1,
      list_create: 0,
      list_update: 2,
      list_delete: 0,
      list_membership_set: 1,
    });
    expect(
      result.plan.operations.map((operation) => operation.operationId),
    ).toEqual(["op_000001", "op_000002", "op_000003", "op_000004"]);
    expect(result.plan.operations[3]).toMatchObject({
      kind: "list_membership_set",
      expectedListIds: [fixture.ids.existingList],
      targetLists: [{ kind: "existing", listId: fixture.ids.addList }],
    });
  });

  it("captures full create/delete state and resolves created references with dependencies", async () => {
    const deleteList = userListFixture({
      listId: asUserListId("UL_delete"),
      name: "Delete",
      slug: "delete",
      description: "old",
      isPrivate: true,
    });
    const deleteMember = repositoryFixture({
      repositoryId: asRepositoryId("R_delete_member"),
      repositoryDatabaseId: asRepositoryDatabaseId("7001"),
      name: "delete-member",
      fullName: "acme/delete-member",
      url: "https://github.com/acme/delete-member",
    });
    const membershipTarget = repositoryFixture({
      repositoryId: asRepositoryId("R_membership_target"),
      repositoryDatabaseId: asRepositoryDatabaseId("7002"),
      name: "membership-target",
      fullName: "acme/membership-target",
      url: "https://github.com/acme/membership-target",
    });
    const fixture = plannerFixture({
      repositories: [deleteMember, membershipTarget],
      lists: [deleteList],
      memberships: [
        {
          listId: deleteList.listId,
          repositoryId: deleteMember.repositoryId,
        },
      ],
    });

    const result = await fixture.service.create({
      snapshotId: fixture.snapshot.id,
      actions: [
        {
          kind: "list_membership_set",
          repositories: {
            kind: "ids",
            repositoryIds: [membershipTarget.repositoryId],
          },
          lists: [{ kind: "created", clientRef: "future" }],
        },
        {
          kind: "list_create",
          clientRef: "future",
          name: "Future",
          description: "created by plan",
          isPrivate: false,
        },
        {
          kind: "list_delete",
          listIds: [deleteList.listId],
        },
      ],
      protectedRepositoryIds: [],
      protectedListIds: [],
    });

    const create = result.plan.operations.find(
      (operation) => operation.kind === "list_create",
    )!;
    const deletion = result.plan.operations.find(
      (operation) => operation.kind === "list_delete",
    )!;
    const membership = result.plan.operations.find(
      (operation) => operation.kind === "list_membership_set",
    )!;
    expect(create.before).toEqual({ listIds: [deleteList.listId] });
    expect(deletion.before).toEqual({
      list: {
        listId: deleteList.listId,
        name: deleteList.name,
        slug: deleteList.slug,
        description: deleteList.description,
        isPrivate: deleteList.isPrivate,
        createdAt: deleteList.createdAt,
        updatedAt: deleteList.updatedAt,
        lastAddedAt: deleteList.lastAddedAt,
      },
      repositoryIds: [deleteMember.repositoryId],
    });
    expect(membership).toMatchObject({
      dependsOn: [create.operationId],
      targetLists: [{ kind: "created", createOperationId: create.operationId }],
    });
    expect(result.plan.dependencies).toEqual([
      {
        operationId: membership.operationId,
        dependsOnOperationId: create.operationId,
      },
    ]);
  });

  it("rejects missing or duplicate created references and incompatible List changes", async () => {
    const missing = plannerFixture();
    await rejection(
      missing.service.create({
        ...missing.validInput,
        actions: [
          {
            kind: "list_membership_set",
            repositories: {
              kind: "ids",
              repositoryIds: [missing.ids.removeRepository],
            },
            lists: [{ kind: "created", clientRef: "missing" }],
          },
        ],
      }),
      "VALIDATION_ERROR",
    );

    const duplicate = plannerFixture();
    await rejection(
      duplicate.service.create({
        ...duplicate.validInput,
        actions: [
          {
            kind: "list_create",
            clientRef: "same",
            name: "One",
            description: null,
            isPrivate: false,
          },
          {
            kind: "list_create",
            clientRef: "same",
            name: "Two",
            description: null,
            isPrivate: false,
          },
        ],
      }),
      "VALIDATION_ERROR",
    );

    const updateDelete = plannerFixture();
    await rejection(
      updateDelete.service.create({
        ...updateDelete.validInput,
        actions: [
          {
            kind: "list_update",
            listIds: [updateDelete.ids.existingList],
            description: "new",
          },
          {
            kind: "list_delete",
            listIds: [updateDelete.ids.existingList],
          },
        ],
      }),
      "VALIDATION_ERROR",
    );
    expect(missing.tracking.savedPlans).toEqual([]);
    expect(duplicate.tracking.savedPlans).toEqual([]);
    expect(updateDelete.tracking.savedPlans).toEqual([]);
  });

  it("rejects List deletion when a complete membership set implicitly removes that List", async () => {
    const fixture = plannerFixture();

    await rejection(
      fixture.service.create({
        snapshotId: fixture.snapshot.id,
        actions: [
          {
            kind: "list_delete",
            listIds: [fixture.ids.existingList],
          },
          {
            kind: "list_membership_set",
            repositories: {
              kind: "ids",
              repositoryIds: [fixture.ids.removeRepository],
            },
            lists: [],
          },
        ],
        protectedRepositoryIds: [],
        protectedListIds: [],
      }),
      "VALIDATION_ERROR",
    );
    expect(fixture.tracking.savedPlans).toEqual([]);
    expect(fixture.tracking.transactionCalls).toBe(0);
  });

  it("rejects missing created List references when a selector matches no repositories", async () => {
    const fixture = plannerFixture();

    await rejection(
      fixture.service.create({
        snapshotId: fixture.snapshot.id,
        actions: [
          {
            kind: "list_membership_set",
            repositories: {
              kind: "filter",
              filter: {
                field: "stargazer_count",
                op: "gt",
                value: 1_000_000,
              },
            },
            lists: [{ kind: "created", clientRef: "missing" }],
          },
        ],
        protectedRepositoryIds: [],
        protectedListIds: [],
      }),
      "VALIDATION_ERROR",
    );
    expect(fixture.tracking.savedPlans).toEqual([]);
    expect(fixture.tracking.transactionCalls).toBe(0);
  });

  it("rejects missing created List references when all repositories are protected", async () => {
    const fixture = plannerFixture();

    await rejection(
      fixture.service.create({
        snapshotId: fixture.snapshot.id,
        actions: [
          {
            kind: "list_membership_add",
            repositories: {
              kind: "ids",
              repositoryIds: [fixture.ids.removeRepository],
            },
            lists: [{ kind: "created", clientRef: "missing" }],
          },
        ],
        protectedRepositoryIds: [fixture.ids.removeRepository],
        protectedListIds: [],
      }),
      "VALIDATION_ERROR",
    );
    expect(fixture.tracking.savedPlans).toEqual([]);
    expect(fixture.tracking.transactionCalls).toBe(0);
  });

  it("enforces configured TTL and operation ceilings with non-retryable errors", async () => {
    const fixture = plannerFixture({
      planTtlMinutes: 60,
      maxPlanActions: 1,
    });
    await rejection(
      fixture.service.create({
        ...fixture.validInput,
        ttlMinutes: 61,
      }),
      "VALIDATION_ERROR",
    );
    await rejection(
      fixture.service.create({
        ...fixture.validInput,
        maxOperations: 2,
      }),
      "VALIDATION_ERROR",
    );
    const twoOperations: PlanRequest = {
      ...fixture.validInput,
      actions: [
        fixture.validInput.actions[0]!,
        {
          kind: "list_update",
          listIds: [fixture.ids.addList],
          description: "change",
        },
      ],
    };
    await rejection(fixture.service.create(twoOperations), "PLAN_TOO_LARGE");
    const callerLower = plannerFixture({ maxPlanActions: 5 });
    await rejection(
      callerLower.service.create({
        ...twoOperations,
        snapshotId: callerLower.snapshot.id,
        actions: [
          callerLower.validInput.actions[0]!,
          {
            kind: "list_update",
            listIds: [callerLower.ids.addList],
            description: "change",
          },
        ],
        maxOperations: 1,
      }),
      "PLAN_TOO_LARGE",
    );
    expect(fixture.tracking.savedPlans).toEqual([]);
    expect(callerLower.tracking.savedPlans).toEqual([]);
  });

  it("does not accept caller binding and commits no partial plan when save fails", async () => {
    const binding = plannerFixture();
    await rejection(
      binding.service.create({
        ...binding.validInput,
        binding: binding.snapshot.binding,
      } as PlanRequest),
      "VALIDATION_ERROR",
    );

    const failed = plannerFixture({ failSave: true });
    await rejection(failed.service.create(failed.validInput), "STORAGE_ERROR");
    expect(failed.tracking.savedPlans).toEqual([]);
    expect(failed.tracking.transactionCalls).toBe(1);
  });

  it("rejects a cyclic resolved graph before the transaction", async () => {
    const fixture = plannerFixture({ cyclicResolver: true });
    await rejection(
      fixture.service.create(fixture.validInput),
      "VALIDATION_ERROR",
    );
    expect(fixture.tracking.savedPlans).toEqual([]);
    expect(fixture.tracking.transactionCalls).toBe(0);
  });
});
