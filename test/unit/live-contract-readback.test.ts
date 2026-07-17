import { describe, expect, it } from "vitest";
import type {
  CreateUserListInput,
  GitHubUserList,
} from "../../src/app/ports/github-port.js";
import { asUserListId } from "../../src/domain/ids.js";
import { verifyCreatedUserListReadback } from "../fixtures/live-contract.js";

const CREATE_INPUT: CreateUserListInput = Object.freeze({
  name: "github-stars-mcp-live-test",
  description: "Disposable github-stars-mcp live contract fixture",
  isPrivate: true,
});

const CREATED_LIST: GitHubUserList = Object.freeze({
  listId: asUserListId("UL_live_readback"),
  name: CREATE_INPUT.name,
  slug: "github-stars-mcp-live-test",
  description: CREATE_INPUT.description,
  isPrivate: CREATE_INPUT.isPrivate,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  lastAddedAt: null,
});

function observedList(overrides: Partial<GitHubUserList>): GitHubUserList {
  return Object.freeze({ ...CREATED_LIST, ...overrides });
}

describe("live contract create readback", () => {
  it("independently reads the created List by its stable ID", async () => {
    const requestedIds: string[] = [];

    const observed = await verifyCreatedUserListReadback(
      {
        getUserList(listId) {
          requestedIds.push(listId);
          return Promise.resolve(CREATED_LIST);
        },
      },
      CREATED_LIST.listId,
      CREATE_INPUT,
    );

    expect(requestedIds).toEqual([CREATED_LIST.listId]);
    expect(observed).toBe(CREATED_LIST);
  });

  it.each([
    ["a missing List", null],
    [
      "a different stable ID",
      observedList({ listId: asUserListId("UL_different") }),
    ],
    ["a different name", observedList({ name: "different-name" })],
    [
      "a different description",
      observedList({ description: "different description" }),
    ],
    ["different privacy", observedList({ isPrivate: false })],
  ] as const)("rejects %s", async (_scenario, observed) => {
    await expect(
      verifyCreatedUserListReadback(
        {
          getUserList() {
            return Promise.resolve(observed);
          },
        },
        CREATED_LIST.listId,
        CREATE_INPUT,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      retryable: false,
    });
  });
});
