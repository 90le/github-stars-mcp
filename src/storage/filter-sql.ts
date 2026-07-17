import {
  decodeRepositoryCursorForSort,
  hashRepositorySort,
  type CursorValue,
} from "../domain/cursor.js";
import { AppError } from "../domain/errors.js";
import {
  normalizeSort,
  parseFilter,
  type FilterExpression,
  type NormalizedRepositorySort,
  type RepositorySort,
} from "../domain/filter.js";

export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

const STRING_COLUMNS = {
  repository_id: "ss.repository_id",
  owner: "rv.owner",
  name: "rv.name",
  full_name: "rv.full_name",
  description: "rv.description",
  primary_language: "rv.primary_language",
  license_spdx_id: "rv.license_spdx_id",
  visibility: "rv.visibility",
} as const;

const BOOLEAN_COLUMNS = {
  is_fork: "rv.is_fork",
  is_archived: "rv.is_archived",
  is_disabled: "rv.is_disabled",
  is_private: "rv.is_private",
} as const;

const TEMPORAL_COLUMNS = {
  pushed_at: "rv.pushed_at",
  updated_at: "rv.updated_at",
  starred_at: "ss.starred_at",
} as const;

const SORT_COLUMNS = {
  stargazer_count: "rv.stargazer_count",
  pushed_at: "rv.pushed_at",
  updated_at: "rv.updated_at",
  starred_at: "ss.starred_at",
  full_name: "rv.full_name",
  repository_id: "ss.repository_id",
} as const;

function validationError(message: string): never {
  throw new AppError("VALIDATION_ERROR", message);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function combine(
  operator: "AND" | "OR",
  fragments: readonly SqlFragment[],
): SqlFragment {
  return {
    sql: fragments.map((fragment) => `(${fragment.sql})`).join(` ${operator} `),
    params: fragments.flatMap((fragment) => fragment.params),
  };
}

function compileStringLeaf(
  field: keyof typeof STRING_COLUMNS,
  op: string,
  value: string | readonly string[] | boolean,
): SqlFragment {
  const column = STRING_COLUMNS[field];
  if (op === "is_null") {
    return {
      sql: `${column} IS ${value === true ? "" : "NOT "}NULL`,
      params: [],
    };
  }
  if (op === "contains") {
    return {
      sql: `COALESCE(instr(${column}, ?) > 0, 0)`,
      params: [value as string],
    };
  }
  if (op === "in" || op === "not_in") {
    const values = value as readonly string[];
    return {
      sql: `COALESCE(${column} ${op === "not_in" ? "NOT " : ""}IN (${placeholders(values.length)}), 0)`,
      params: values,
    };
  }
  return {
    sql: `COALESCE(${column} ${op === "neq" ? "<>" : "="} ?, 0)`,
    params: [value as string],
  };
}

function compileNumberLeaf(
  op: string,
  value: number | readonly number[],
): SqlFragment {
  if (op === "in" || op === "not_in") {
    const values = value as readonly number[];
    return {
      sql: `rv.stargazer_count ${op === "not_in" ? "NOT " : ""}IN (${placeholders(values.length)})`,
      params: values,
    };
  }
  const operator = {
    eq: "=",
    neq: "<>",
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
  }[op];
  if (operator === undefined) {
    return validationError("unsupported numeric filter operator");
  }
  return {
    sql: `rv.stargazer_count ${operator} ?`,
    params: [value as number],
  };
}

function compileTemporalLeaf(
  field: keyof typeof TEMPORAL_COLUMNS,
  op: string,
  value: string | boolean,
): SqlFragment {
  const column = TEMPORAL_COLUMNS[field];
  if (op === "is_null") {
    return {
      sql: `${column} IS ${value === true ? "" : "NOT "}NULL`,
      params: [],
    };
  }
  const operator = op === "before" ? "<" : op === "after" ? ">" : "=";
  return {
    sql: `COALESCE(julianday(${column}) ${operator} julianday(?), 0)`,
    params: [value as string],
  };
}

function listMembershipPredicate(
  operator: "=" | "IN",
  value: string | readonly string[],
): SqlFragment {
  const values = typeof value === "string" ? [value] : value;
  return {
    sql:
      "EXISTS (SELECT 1 FROM list_memberships m " +
      "WHERE m.snapshot_id = ss.snapshot_id " +
      "AND m.repository_id = ss.repository_id " +
      `AND m.list_id ${operator} (${operator === "=" ? "?" : placeholders(values.length)}))`,
    params: values,
  };
}

function anyListMembership(): string {
  return (
    "EXISTS (SELECT 1 FROM list_memberships m " +
    "WHERE m.snapshot_id = ss.snapshot_id " +
    "AND m.repository_id = ss.repository_id)"
  );
}

function compileCollectionLeaf(
  field: "topics" | "list_ids",
  op: string,
  value: string | readonly string[] | boolean,
): SqlFragment {
  if (field === "topics") {
    if (op === "is_null") {
      return value === true
        ? {
            sql: "(rv.topics_json IS NULL OR json_array_length(rv.topics_json) = 0)",
            params: [],
          }
        : {
            sql: "(rv.topics_json IS NOT NULL AND json_array_length(rv.topics_json) > 0)",
            params: [],
          };
    }
    const values: readonly string[] =
      typeof value === "string" ? [value] : (value as readonly string[]);
    const condition =
      op === "contains" || op === "not_contains"
        ? "topic.value = ?"
        : `topic.value IN (${placeholders(values.length)})`;
    const negate = op === "not_contains" || op === "not_in";
    return {
      sql:
        `${negate ? "NOT " : ""}EXISTS (` +
        "SELECT 1 FROM json_each(rv.topics_json) AS topic " +
        `WHERE ${condition})`,
      params: values,
    };
  }

  if (op === "is_null") {
    const exists = anyListMembership();
    return {
      sql: value === true ? `NOT ${exists}` : exists,
      params: [],
    };
  }
  const membership = listMembershipPredicate(
    op === "contains" || op === "not_contains" ? "=" : "IN",
    value as string | readonly string[],
  );
  return {
    sql:
      op === "not_contains" || op === "not_in"
        ? `NOT (${membership.sql})`
        : membership.sql,
    params: membership.params,
  };
}

function compileExpression(filter: FilterExpression): SqlFragment {
  if ("all" in filter) {
    return combine("AND", filter.all.map(compileExpression));
  }
  if ("any" in filter) {
    return combine("OR", filter.any.map(compileExpression));
  }
  if ("not" in filter) {
    const child = compileExpression(filter.not);
    return { sql: `NOT (${child.sql})`, params: child.params };
  }

  if (filter.field in STRING_COLUMNS) {
    return compileStringLeaf(
      filter.field as keyof typeof STRING_COLUMNS,
      filter.op,
      filter.value as string | readonly string[] | boolean,
    );
  }
  if (filter.field === "stargazer_count") {
    return compileNumberLeaf(filter.op, filter.value);
  }
  if (filter.field in BOOLEAN_COLUMNS) {
    const column =
      BOOLEAN_COLUMNS[filter.field as keyof typeof BOOLEAN_COLUMNS];
    return {
      sql: `${column} ${filter.op === "neq" ? "<>" : "="} ?`,
      params: [Number(filter.value)],
    };
  }
  if (filter.field in TEMPORAL_COLUMNS) {
    return compileTemporalLeaf(
      filter.field as keyof typeof TEMPORAL_COLUMNS,
      filter.op,
      filter.value as string | boolean,
    );
  }
  if (filter.field === "topics" || filter.field === "list_ids") {
    return compileCollectionLeaf(filter.field, filter.op, filter.value);
  }

  const exists = anyListMembership();
  const expectedUnclassified =
    filter.op === "eq" ? filter.value : !filter.value;
  return {
    sql: expectedUnclassified ? `NOT ${exists}` : exists,
    params: [],
  };
}

export function compileFilter(filter: FilterExpression): SqlFragment {
  return compileExpression(parseFilter(filter));
}

function orderExpression(field: NormalizedRepositorySort["field"]): string {
  const column = SORT_COLUMNS[field];
  return field === "pushed_at" ||
    field === "updated_at" ||
    field === "starred_at"
    ? `julianday(${column})`
    : column;
}

export function compileOrder(sort: readonly RepositorySort[]): string {
  const clauses: string[] = [];
  for (const term of normalizeSort(sort)) {
    const column = SORT_COLUMNS[term.field];
    if (term.field === "pushed_at") {
      clauses.push(`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END ASC`);
    }
    clauses.push(
      `${orderExpression(term.field)} ${term.direction.toUpperCase()}`,
    );
  }
  return clauses.join(", ");
}

function validateCursorValue(
  term: NormalizedRepositorySort,
  value: CursorValue,
): void {
  if (term.field === "stargazer_count") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      validationError("repository cursor stargazer value is invalid");
    }
    return;
  }
  if (term.field === "pushed_at" && value === null) return;
  if (typeof value !== "string") {
    validationError(`repository cursor ${term.field} value is invalid`);
  }
  if (
    (term.field === "pushed_at" ||
      term.field === "updated_at" ||
      term.field === "starred_at") &&
    !Number.isFinite(Date.parse(value))
  ) {
    validationError(`repository cursor ${term.field} timestamp is invalid`);
  }
}

function equalityCondition(
  term: NormalizedRepositorySort,
  value: CursorValue,
): SqlFragment {
  const column = SORT_COLUMNS[term.field];
  if (value === null) return { sql: `${column} IS NULL`, params: [] };
  if (
    term.field === "pushed_at" ||
    term.field === "updated_at" ||
    term.field === "starred_at"
  ) {
    return {
      sql: `julianday(${column}) = julianday(?)`,
      params: [value],
    };
  }
  return { sql: `${column} = ?`, params: [value] };
}

function afterCondition(
  term: NormalizedRepositorySort,
  value: Exclude<CursorValue, null>,
): SqlFragment {
  const column = SORT_COLUMNS[term.field];
  const operator = term.direction === "asc" ? ">" : "<";
  const temporal =
    term.field === "pushed_at" ||
    term.field === "updated_at" ||
    term.field === "starred_at";
  const comparison = temporal
    ? `julianday(${column}) ${operator} julianday(?)`
    : `${column} ${operator} ?`;
  return {
    sql:
      term.field === "pushed_at"
        ? `(${column} IS NULL OR ${comparison})`
        : comparison,
    params: [value],
  };
}

function branch(
  prefixTerms: readonly NormalizedRepositorySort[],
  prefixValues: readonly CursorValue[],
  tail: SqlFragment,
): SqlFragment {
  const prefix = prefixTerms.map((term, index) =>
    equalityCondition(term, prefixValues[index]!),
  );
  return combine("AND", [...prefix, tail]);
}

export function compileCursor(
  sort: readonly RepositorySort[],
  cursor: string | null,
): SqlFragment {
  if (cursor === null) return { sql: "1 = 1", params: [] };

  const normalized = normalizeSort(sort);
  const valueTerms = normalized.filter(
    (term) => term.field !== "repository_id",
  );
  const payload = decodeRepositoryCursorForSort(
    cursor,
    hashRepositorySort(sort),
  );
  if (
    payload.values.length !== valueTerms.length ||
    payload.nulls.length !== valueTerms.length
  ) {
    return validationError(
      "repository cursor values do not match normalized sort",
    );
  }
  valueTerms.forEach((term, index) => {
    validateCursorValue(term, payload.values[index]!);
  });

  const branches: SqlFragment[] = [];
  valueTerms.forEach((term, index) => {
    const value = payload.values[index]!;
    if (value !== null) {
      branches.push(
        branch(
          valueTerms.slice(0, index),
          payload.values.slice(0, index),
          afterCondition(term, value),
        ),
      );
    }
  });
  branches.push(
    branch(valueTerms, payload.values, {
      sql: "ss.repository_id > ?",
      params: [payload.repositoryId],
    }),
  );
  return combine("OR", branches);
}
