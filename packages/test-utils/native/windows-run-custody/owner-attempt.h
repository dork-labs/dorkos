#ifndef DORKOS_WINDOWS_RUN_CUSTODY_OWNER_ATTEMPT_H
#define DORKOS_WINDOWS_RUN_CUSTODY_OWNER_ATTEMPT_H

#include <windows.h>

enum {
  DORKOS_OWNER_BINDING_BYTES = 16,
  DORKOS_OWNER_CAPABILITY_BYTES = 32,
  DORKOS_OWNER_ADMISSION = 1,
  DORKOS_OWNER_CONFIRMATION = 2,
};

typedef struct {
  BYTE scope[DORKOS_OWNER_BINDING_BYTES];
  BYTE attempt[DORKOS_OWNER_BINDING_BYTES];
  BYTE capabilities[2][DORKOS_OWNER_CAPABILITY_BYTES];
  BYTE next_phase;
} DorkosOwnerAttempt;

/*
 * Initialize fresh storage from the guardian's private bootstrap inputs.
 * The input buffers are borrowed; the attempt owns its own copies.
 */
BOOL dorkos_init_owner_attempt(DorkosOwnerAttempt *attempt, const BYTE *scope_id,
                              const BYTE *attempt_id, const BYTE *main_capability,
                              const BYTE *scope_capability);

/* Await the exact owned server pipe or the optional cancellation event. */
BOOL dorkos_connect_owner_attempt_pipe(HANDLE pipe, ULONGLONG deadline, HANDLE cancellation);

/*
 * Run the single admission or confirmation exchange for this attempt. The
 * ordered handles are the guardian's connected main and scope server pipes,
 * borrowed for the exclusive exchange. The Windows uptime deadline is absolute. An optional cancellation
 * event makes an in-flight attempt retire promptly.
 * A returned failure preserves the primary Windows error and retires the
 * attempt. The caller owns both pipes and any suspended target throughout.
 * Confirmation authenticates current replies; it does not resume a thread or
 * replace the guardian's independent final owner-close observation.
 */
BOOL dorkos_exchange_owner_attempt(DorkosOwnerAttempt *attempt, HANDLE main_pipe,
                                  HANDLE scope_pipe, BYTE phase, ULONGLONG deadline,
                                  HANDLE cancellation);
void dorkos_clear_owner_attempt(DorkosOwnerAttempt *attempt);

#endif
