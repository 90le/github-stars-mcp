const RECONCILE_RETRYABLE_FAILED_SQL = `
DROP TRIGGER reconciliation_requires_current_unresolved_attempt;
DROP TRIGGER reconciled_projection_requires_latest_event;

CREATE TRIGGER reconciliation_requires_current_reconcilable_attempt
BEFORE INSERT ON run_operation_reconciliations
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
    FROM run_operations AS ro
    JOIN run_operation_attempts AS a
      ON a.run_id=ro.run_id
     AND a.operation_id=ro.operation_id
     AND a.attempt=ro.attempts
    WHERE ro.run_id=NEW.run_id
      AND ro.operation_id=NEW.operation_id
      AND ro.attempts=NEW.attempt
      AND a.finished_at IS NOT NULL
      AND NEW.observed_at>=a.finished_at
      AND (
        (
          ro.status='unresolved'
          AND ro.reconciliation='unknown'
          AND a.status='unresolved'
          AND a.reconciliation='unknown'
        )
        OR
        (
          ro.status='failed'
          AND ro.reconciliation='confirmed_not_applied'
          AND a.status='failed'
          AND a.reconciliation='confirmed_not_applied'
        )
      )
  ) THEN RAISE(ABORT,'reconciliation requires current reconcilable attempt') END;
END;

CREATE TRIGGER reconciled_projection_requires_latest_event
BEFORE UPDATE OF status,reconciliation,after_json,error_json,finished_at
ON run_operations
WHEN (
  OLD.status='unresolved' AND OLD.reconciliation='unknown'
) OR (
  OLD.status='failed'
  AND OLD.reconciliation='confirmed_not_applied'
  AND NEW.status<>'pending'
)
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
    FROM run_operation_reconciliations AS e
    WHERE e.run_id=NEW.run_id
      AND e.operation_id=NEW.operation_id
      AND e.attempt=NEW.attempts
      AND e.event_sequence=(
        SELECT MAX(e2.event_sequence)
        FROM run_operation_reconciliations AS e2
        WHERE e2.run_id=NEW.run_id AND e2.operation_id=NEW.operation_id
      )
      AND e.status=NEW.status
      AND e.reconciliation=NEW.reconciliation
      AND e.after_json=NEW.after_json
      AND ((e.error_json IS NULL AND NEW.error_json IS NULL) OR e.error_json=NEW.error_json)
      AND NEW.finished_at=e.observed_at
  ) THEN RAISE(ABORT,'reconciled projection requires matching latest event') END;
END;
`.trim();

export const reconcileRetryableFailedMigration = Object.freeze({
  version: 2,
  name: "reconcile-retryable-failed",
  sql: RECONCILE_RETRYABLE_FAILED_SQL,
});
