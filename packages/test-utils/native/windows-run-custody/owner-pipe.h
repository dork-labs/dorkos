#ifndef DORKOS_WINDOWS_RUN_CUSTODY_OWNER_PIPE_H
#define DORKOS_WINDOWS_RUN_CUSTODY_OWNER_PIPE_H

#include <windows.h>

typedef enum { DORKOS_MAIN_OWNER, DORKOS_SCOPE_OWNER } DorkosOwnerRole;

/*
 * Create one non-inheritable, overlapped duplex server pipe for a fresh
 * 32-character lowercase hex scope ID and one role. The current logon has
 * client access. The guardian owns the returned handle and closes it.
 * INVALID_HANDLE_VALUE leaves the original Windows error.
 */
HANDLE dorkos_create_owner_pipe(LPCWSTR scope_id, DorkosOwnerRole role);

/*
 * After reading a message on the server end, compare the peer's user and logon
 * SID to the guardian's. Call only on the guardian's unimpersonated thread.
 * The pipe is borrowed. This establishes OS identity only. Role capability
 * and current-attempt authentication must still succeed before authorization.
 */
BOOL dorkos_check_owner_pipe_identity(HANDLE pipe);

#endif
