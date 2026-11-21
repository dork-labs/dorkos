#ifndef DORKOS_WINDOWS_RUN_CUSTODY_SUSPENDED_TARGET_H
#define DORKOS_WINDOWS_RUN_CUSTODY_SUSPENDED_TARGET_H

#include <windows.h>

typedef struct {
  HANDLE input;
  HANDLE output;
  HANDLE error;
} DorkosTargetStdio;

typedef struct {
  HANDLE job;
  PROCESS_INFORMATION process;
} DorkosSuspendedTarget;

/*
 * A guardian-only creation step. The executable and cwd are the caller's
 * resolved absolute paths. The command line is writable and the environment
 * is an explicit double-NUL-terminated UTF-16 block. Stdio inputs are borrowed
 * file, console or pipe handles. The guardian serializes process creation.
 *
 * On success, the caller owns the private Job and actual process and thread
 * handles. The primary thread stays suspended. Only the guardian may later
 * resume it after checking its two lifelines and target identity.
 *
 * Supply fresh output storage. On failure it is cleared, no target is
 * transferred and GetLastError reports the first failed operation.
 */
BOOL dorkos_create_suspended_target(LPCWSTR executable, LPWSTR command_line,
                                    LPCWSTR cwd, WCHAR *environment,
                                    const DorkosTargetStdio *stdio_handles,
                                    DorkosSuspendedTarget *target);

#endif
