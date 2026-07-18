import type { SerializedDomainError } from "../../domain/errors.js";
import type {
  ListMembershipQuery,
  ListMembershipQueryPage,
  ListQuery,
  ListQueryPage,
  ListSummary,
  RepositoryQuery,
  RepositoryQueryPage,
} from "../../domain/filter.js";
import type {
  PlanId,
  RepositoryId,
  RunId,
  SnapshotId,
  UserListId,
} from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type { ChangePlan, PlanState } from "../../domain/plan.js";
import type {
  AccountBinding,
  ObservedRepositoryMetadata,
  RepositoryView,
} from "../../domain/repository.js";
import type {
  ChangeRun,
  RunOperation,
  RunOperationAttempt,
  RunOperationReconciliation,
  RunOperationStatus,
  RunState,
} from "../../domain/run.js";
import type {
  ListCoverage,
  Snapshot,
  SnapshotBatch,
  SnapshotCounts,
  SnapshotDraft,
  SnapshotVerificationBatch,
} from "../../domain/snapshot.js";

export interface Lease {
  readonly name: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface AcquireLeaseInput {
  readonly name: string;
  readonly ownerId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export interface LeaseGuard {
  readonly name: string;
  readonly ownerId: string;
  readonly now: string;
}

export interface CompleteSnapshotInput {
  readonly id: SnapshotId;
  readonly completedAt: string;
  readonly listCoverage: Exclude<ListCoverage, "collecting">;
  readonly counts: SnapshotCounts;
  readonly warningCount: number;
  readonly sourceRateLimit: JsonValue | null;
  readonly lease: LeaseGuard;
}

export interface FailSnapshotInput {
  readonly id: SnapshotId;
  readonly failedAt: string;
  readonly sourceRateLimit: JsonValue | null;
  readonly lease: LeaseGuard;
}

export interface AuditPage {
  readonly items: readonly RunOperation[];
  readonly total: number;
  readonly nextSequence: number | null;
}

export type RunOperationCounts = Readonly<Record<RunOperationStatus, number>>;

export interface IncompleteRunSummary {
  readonly runId: RunId;
  readonly planId: PlanId;
  readonly state: "pending" | "running" | "partial";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly counts: RunOperationCounts;
}

export interface IncompleteRunSummaries {
  readonly items: readonly IncompleteRunSummary[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface RunOperationAttemptPage {
  readonly items: readonly RunOperationAttempt[];
  readonly total: number;
  readonly nextAttempt: number | null;
}

export interface RunOperationReconciliationPage {
  readonly items: readonly RunOperationReconciliation[];
  readonly total: number;
  readonly nextEventSequence: number | null;
}

interface FinishBeforeDispatchBase {
  readonly phase: "before_dispatch";
  readonly runId: RunId;
  readonly operationId: string;
  readonly finishedAt: string;
  readonly lease: LeaseGuard;
}

interface FinishAfterDispatchBase {
  readonly phase: "after_dispatch";
  readonly runId: RunId;
  readonly operationId: string;
  readonly externalRequestId: string | null;
  readonly after: JsonValue;
  readonly finishedAt: string;
  readonly lease: LeaseGuard;
}

export type FinishRunOperationInput =
  | Readonly<
      FinishBeforeDispatchBase & {
        readonly status: "skipped";
        readonly reconciliation: "not_required";
        readonly error: null;
      }
    >
  | Readonly<
      FinishBeforeDispatchBase & {
        readonly status: "failed";
        readonly reconciliation: "confirmed_not_applied";
        readonly error: SerializedDomainError;
      }
    >
  | Readonly<
      FinishAfterDispatchBase & {
        readonly status: "succeeded";
        readonly reconciliation: "not_required";
        readonly error: null;
      }
    >
  | Readonly<
      FinishAfterDispatchBase & {
        readonly status: "failed";
        readonly reconciliation: "confirmed_not_applied";
        readonly error: SerializedDomainError;
      }
    >
  | Readonly<
      FinishAfterDispatchBase & {
        readonly status: "unresolved";
        readonly reconciliation: "unknown";
        readonly error: SerializedDomainError & { readonly retryable: false };
      }
    >;

interface ReconcileBase {
  readonly runId: RunId;
  readonly operationId: string;
  readonly after: JsonValue;
  readonly observedAt: string;
  readonly lease: LeaseGuard;
}

export type ReconcileRunOperationInput =
  | Readonly<
      ReconcileBase & {
        readonly status: "succeeded";
        readonly reconciliation: "confirmed_applied";
        readonly error: null;
      }
    >
  | Readonly<
      ReconcileBase & {
        readonly status: "failed";
        readonly reconciliation: "confirmed_not_applied";
        readonly error: SerializedDomainError & { readonly retryable: true };
      }
    >
  | Readonly<
      ReconcileBase & {
        readonly status: "unresolved";
        readonly reconciliation: "unknown";
        readonly error: SerializedDomainError & { readonly retryable: false };
      }
    >;

export interface StorageTransaction {
  assertLease(guard: LeaseGuard): Lease;
  createSnapshot(input: {
    readonly draft: SnapshotDraft;
    readonly lease: LeaseGuard;
  }): Snapshot;
  appendSnapshotBatch(input: {
    readonly id: SnapshotId;
    readonly batch: SnapshotBatch;
    readonly lease: LeaseGuard;
  }): void;
  beginSnapshotVerification(input: {
    readonly id: SnapshotId;
    readonly listCoverage: Exclude<ListCoverage, "collecting">;
    readonly lease: LeaseGuard;
  }): void;
  appendSnapshotVerificationBatch(input: {
    readonly id: SnapshotId;
    readonly batch: SnapshotVerificationBatch;
    readonly lease: LeaseGuard;
  }): void;
  finishSnapshotVerification(input: {
    readonly id: SnapshotId;
    readonly lease: LeaseGuard;
  }): void;
  completeSnapshot(input: CompleteSnapshotInput): Snapshot;
  failSnapshot(input: FailSnapshotInput): Snapshot;
  getCompleteSnapshot(id: SnapshotId): Snapshot | null;
  getLatestCompleteSnapshot(binding: AccountBinding): Snapshot | null;
  getRepositoryMetadata(id: RepositoryId): ObservedRepositoryMetadata | null;
  getSnapshotRepository(
    snapshotId: SnapshotId,
    repositoryId: RepositoryId,
  ): RepositoryView | null;
  getSnapshotListSummary(
    snapshotId: SnapshotId,
    listId: UserListId,
  ): ListSummary | null;
  queryRepositories(input: RepositoryQuery): RepositoryQueryPage;
  queryLists(input: ListQuery): ListQueryPage;
  queryListMemberships(input: ListMembershipQuery): ListMembershipQueryPage;
  hasStar(snapshotId: SnapshotId, repositoryId: RepositoryId): boolean;
  savePlan(plan: ChangePlan): void;
  getPlan(id: PlanId): ChangePlan | null;
  compareAndSetPlanState(input: {
    readonly planId: PlanId;
    readonly expected: readonly PlanState[];
    readonly next: PlanState;
  }): ChangePlan;
  createRun(input: {
    readonly run: ChangeRun;
    readonly lease: LeaseGuard;
  }): void;
  getRun(id: RunId): ChangeRun | null;
  getLatestRunForPlan(planId: PlanId): ChangeRun | null;
  compareAndSetRunState(input: {
    readonly runId: RunId;
    readonly expected: readonly RunState[];
    readonly next: RunState;
    readonly finishedAt: string | null;
    readonly lease: LeaseGuard;
  }): ChangeRun;
  createRunOperation(input: {
    readonly operation: RunOperation;
    readonly lease: LeaseGuard;
  }): void;
  startRunOperation(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly startedAt: string;
    readonly lease: LeaseGuard;
  }): RunOperation;
  getRunOperation(input: {
    readonly runId: RunId;
    readonly operationId: string;
  }): RunOperation | null;
  retryRunOperation(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly maxAttempts: number;
    readonly lease: LeaseGuard;
  }): RunOperation;
  listRunOperations(runId: RunId): readonly RunOperation[];
  listRunOperationsPage(input: {
    readonly runId: RunId;
    readonly afterSequence: number | null;
    readonly pageSize: number;
  }): AuditPage;
  finishRunOperation(input: FinishRunOperationInput): RunOperation;
  reconcileRunOperation(input: ReconcileRunOperationInput): RunOperation;
  getRunOperationAttempt(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly attempt: number;
  }): RunOperationAttempt | null;
  listRunOperationAttemptsPage(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly afterAttempt: number | null;
    readonly pageSize: number;
  }): RunOperationAttemptPage;
  listRunOperationReconciliationsPage(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly afterEventSequence: number | null;
    readonly pageSize: number;
  }): RunOperationReconciliationPage;
  recoverAbandonedRuns(input: {
    readonly binding: AccountBinding;
    readonly lease: LeaseGuard;
  }): readonly RunId[];
  acquireLease(input: AcquireLeaseInput): Lease | null;
  renewLease(input: AcquireLeaseInput): Lease;
  releaseLease(input: {
    readonly name: string;
    readonly ownerId: string;
  }): void;
}

export interface StoragePort
  extends StorageTransaction, DiscoveryCandidateStorage {
  migrate(): void;
  getSchemaVersion(): number;
  withTransaction<T>(fn: (tx: StorageTransaction) => T): T;
  getIncompleteRunSummaries(input: {
    readonly binding: AccountBinding;
    readonly limit: number;
  }): IncompleteRunSummaries;
  recoverAbandonedSnapshots(input: {
    readonly binding: AccountBinding;
    readonly lease: LeaseGuard;
  }): readonly SnapshotId[];
  recoverIncompleteSnapshots(now: string): readonly SnapshotId[];
  recoverInterruptedRuns(now: string): readonly RunId[];
  close(): void;
}

export interface DiscoveryCandidateInput {
  readonly binding: AccountBinding;
  readonly repository: import("../../domain/repository.js").Repository;
  readonly query: string;
  readonly discoveredAt: string;
}

export interface DiscoveryCandidatePage {
  readonly items: readonly {
    readonly repository: import("../../domain/repository.js").Repository;
    readonly query: string;
    readonly state: "discovered" | "selected" | "dismissed" | "starred";
    readonly firstDiscoveredAt: string;
    readonly lastDiscoveredAt: string;
  }[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface DiscoveryCandidateStorage {
  saveDiscoveredCandidate(input: DiscoveryCandidateInput): void;
  queryDiscoveryCandidates(input: {
    readonly binding: AccountBinding;
    readonly state?: "discovered" | "selected" | "dismissed" | "starred";
    readonly query?: string;
    readonly pageSize: number;
    readonly cursor: string | null;
  }): DiscoveryCandidatePage;
}

export type {
  RunOperationAttempt,
  RunOperationAttemptStatus,
  RunOperationReconciliation,
} from "../../domain/run.js";
