import { AppError } from "../domain/errors.js";

const MAX_LINK_HEADER_LENGTH = 16_384;
const MAX_GRAPHQL_CURSOR_LENGTH = 4_096;
const POSITIVE_DECIMAL = /^[1-9]\d*$/u;
const LINK_SEGMENT = /^<([^<>"\s]+)>\s*;\s*rel="([^"]+)"$/u;
const RELATION_TOKEN = /^[A-Za-z][A-Za-z0-9.-]*$/u;

function invalidCursor(): AppError {
  return new AppError("VALIDATION_ERROR", "Star cursor is invalid", {
    retryable: false,
    details: {
      operation: "listStarredRepositories",
      reason: "invalid_cursor",
    },
  });
}

function malformedLink(): AppError {
  return new AppError(
    "GITHUB_UNAVAILABLE",
    "GitHub returned malformed pagination data",
    {
      retryable: false,
      details: {
        operation: "listStarredRepositories",
        reason: "malformed_remote_data",
      },
    },
  );
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function positivePage(value: unknown, failure: () => AppError): number {
  if (
    typeof value !== "string" ||
    !POSITIVE_DECIMAL.test(value) ||
    !wellFormedUnicode(value)
  ) {
    throw failure();
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page <= 0) throw failure();
  return page;
}

export function parseRestPageCursor(cursor: string | null): number {
  return cursor === null ? 1 : positivePage(cursor, invalidCursor);
}

function nextTargetCursor(target: string): string {
  if (
    !target.startsWith("https://api.github.com/user/starred?") ||
    target.includes("#") ||
    !controlFree(target) ||
    !wellFormedUnicode(target)
  ) {
    throw malformedLink();
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw malformedLink();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.origin !== "https://api.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/user/starred" ||
    url.hash !== "" ||
    target !== `${url.origin}${url.pathname}${url.search}`
  ) {
    throw malformedLink();
  }

  const pageValues = url.searchParams.getAll("page");
  const perPageValues = url.searchParams.getAll("per_page");
  const keys = [...url.searchParams.keys()];
  if (
    pageValues.length !== 1 ||
    perPageValues.length > 1 ||
    keys.some((key) => key !== "page" && key !== "per_page") ||
    (perPageValues.length === 1 && perPageValues[0] !== "100")
  ) {
    throw malformedLink();
  }
  const page = pageValues[0];
  if (page === undefined) throw malformedLink();
  positivePage(page, malformedLink);

  const canonicalQueries = new Set([
    `?page=${page}`,
    `?page=${page}&per_page=100`,
    `?per_page=100&page=${page}`,
  ]);
  if (!canonicalQueries.has(url.search)) throw malformedLink();
  return page;
}

export function parseRestNextCursor(link: unknown): string | null {
  if (link === undefined) return null;
  if (
    typeof link !== "string" ||
    link.length === 0 ||
    link.length > MAX_LINK_HEADER_LENGTH ||
    !controlFree(link) ||
    !wellFormedUnicode(link)
  ) {
    throw malformedLink();
  }

  let nextTarget: string | null = null;
  const segments = link.split(",");
  if (segments.length === 0) throw malformedLink();
  for (const segment of segments) {
    const match = LINK_SEGMENT.exec(segment.trim());
    if (match === null) throw malformedLink();
    const target = match[1];
    const relationValue = match[2];
    if (target === undefined || relationValue === undefined) {
      throw malformedLink();
    }
    const relations = relationValue.split(" ");
    if (
      relations.length === 0 ||
      relations.some(
        (relation) => relation.length === 0 || !RELATION_TOKEN.test(relation),
      )
    ) {
      throw malformedLink();
    }
    const nextCount = relations.filter(
      (relation) => relation === "next",
    ).length;
    if (nextCount > 1 || (nextCount === 1 && nextTarget !== null)) {
      throw malformedLink();
    }
    if (nextCount === 1) nextTarget = target;
  }

  return nextTarget === null ? null : nextTargetCursor(nextTarget);
}

type GraphqlListMethod = "listUserLists" | "listUserListItems";
type GraphqlListOperation = "ViewerLists" | "UserListItems";

function validGraphqlCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_GRAPHQL_CURSOR_LENGTH &&
    controlFree(value) &&
    wellFormedUnicode(value)
  );
}

export function parseGraphqlInputCursor(
  cursor: string | null,
  operation: GraphqlListMethod,
): string | null {
  if (cursor === null) return null;
  if (!validGraphqlCursor(cursor)) {
    throw new AppError("VALIDATION_ERROR", "GraphQL cursor is invalid", {
      retryable: false,
      details: { operation, reason: "invalid_cursor" },
    });
  }
  return cursor;
}

export function parseGraphqlNextCursor(
  hasNextPage: unknown,
  endCursor: unknown,
  operation: GraphqlListOperation,
): string | null {
  if (
    typeof hasNextPage !== "boolean" ||
    (endCursor !== null && !validGraphqlCursor(endCursor)) ||
    (hasNextPage && endCursor === null)
  ) {
    throw new AppError(
      "GITHUB_UNAVAILABLE",
      "GitHub returned malformed pagination data",
      {
        retryable: false,
        details: { operation, reason: "malformed_remote_data" },
      },
    );
  }
  return hasNextPage ? endCursor : null;
}
