import {
  newOperationId,
  newPlanId,
  newRequestId,
  newRunId,
  newSnapshotId,
  type PlanId,
  type RunId,
  type SnapshotId,
} from "../../domain/ids.js";

export interface Clock {
  now(): string;
  monotonicMs(): number;
}

export interface IdGenerator {
  snapshotId(): SnapshotId;
  planId(): PlanId;
  runId(): RunId;
  requestId(): string;
  operationId(): string;
}

export class SystemRuntime implements Clock, IdGenerator {
  now(): string {
    return new Date().toISOString();
  }

  monotonicMs(): number {
    return performance.now();
  }

  snapshotId(): SnapshotId {
    return newSnapshotId();
  }

  planId(): PlanId {
    return newPlanId();
  }

  runId(): RunId {
    return newRunId();
  }

  requestId(): string {
    return newRequestId();
  }

  operationId(): string {
    return newOperationId();
  }
}
