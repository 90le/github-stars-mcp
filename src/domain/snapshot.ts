import type { JsonValue } from "./json.js";
import type { SnapshotId } from "./ids.js";
import type {
  AccountBinding,
  ListMembership,
  ObservedRepositoryMetadata,
  StarRecord,
  UserList,
} from "./repository.js";

export interface SnapshotDraft {
  readonly id: SnapshotId;
  readonly binding: AccountBinding;
  readonly mode: "full" | "incremental";
  readonly startedAt: string;
}

export interface SnapshotCounts {
  readonly repositories: number;
  readonly stars: number;
  readonly lists: number;
  readonly memberships: number;
}

export interface Snapshot extends SnapshotDraft {
  readonly status: "building" | "complete" | "failed";
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly counts: SnapshotCounts;
  readonly warningCount: number;
  readonly sourceRateLimit: JsonValue | null;
}

export interface SnapshotBatch {
  readonly repositories: readonly ObservedRepositoryMetadata[];
  readonly stars: readonly StarRecord[];
  readonly lists: readonly UserList[];
  readonly memberships: readonly ListMembership[];
}
