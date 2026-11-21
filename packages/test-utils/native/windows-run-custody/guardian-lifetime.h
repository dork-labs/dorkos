#ifndef DORKOS_WINDOWS_RUN_CUSTODY_GUARDIAN_LIFETIME_H
#define DORKOS_WINDOWS_RUN_CUSTODY_GUARDIAN_LIFETIME_H

#include "owner-attempt.h"
#include "suspended-target.h"

typedef enum {
  DORKOS_RUN_FAILED,
  DORKOS_RUN_COMPLETED,
  DORKOS_RUN_MAIN_OWNER_LOST,
  DORKOS_RUN_SCOPE_OWNER_LOST,
  DORKOS_RUN_STOPPED,
} DorkosRunEnd;

typedef struct {
  DorkosRunEnd end;
  DWORD error;
  DWORD cleanup_error;
  DWORD leader_exit_code;
  BOOL resumed;
  BOOL joined;
} DorkosRunResult;

typedef struct {
  HANDLE stop_event;
  /* The guardian has resumed the exact native target. Queue its fact without waiting for a reader. */
  DWORD (*publish_spawn)(const PROCESS_INFORMATION *process, void *context);
  void *context;
} DorkosGuardianControl;

/*
 * Run exclusively in the private guardian. Consume and clear a fresh target
 * returned by dorkos_create_suspended_target and retire its admitted attempt.
 * The connected main and scope server handles are borrowed exclusively until
 * return. The caller retains responsibility for closing them. No messages
 * follow the confirmation response on the two lifetime pipes.
 *
 * The confirmation deadline uses Windows uptime. Owner loss ends execution
 * and starts a new bounded local join. A result with joined=false has no
 * complete cohort proof. The primary and cleanup errors are independent.
 * Borrow optional control storage through return. A signaled stop event
 * interrupts confirmation or live execution and starts immediate owned join.
 */
DorkosRunResult dorkos_run_owned_target(DorkosSuspendedTarget *target, LPCWSTR executable,
                                       DorkosOwnerAttempt *attempt, HANDLE main_pipe,
                                       HANDLE scope_pipe, ULONGLONG confirmation_deadline,
                                       const DorkosGuardianControl *control);

#endif
