import { AppError } from "../domain/errors.js";

export class AmbiguousMutationError extends AppError {
  constructor(
    readonly operationId: string,
    readonly mutationName: string,
    cause: unknown,
  ) {
    super(
      "RECONCILIATION_REQUIRED",
      `Mutation ${mutationName} has an unknown outcome.`,
      {
        retryable: false,
        details: { operationId, mutationName },
        cause,
      },
    );
    this.name = "AmbiguousMutationError";
  }
}
