#ifndef DORKOS_WINDOWS_RUN_CUSTODY_GUARDIAN_IO_H
#define DORKOS_WINDOWS_RUN_CUSTODY_GUARDIAN_IO_H

#include <windows.h>

BOOL dorkos_io_is_current(ULONGLONG deadline, HANDLE cancellation);
BOOL dorkos_finish_io(HANDLE pipe, OVERLAPPED *operation, DWORD *count, ULONGLONG deadline,
                      HANDLE cancellation);
BOOL dorkos_pipe_transfer(HANDLE pipe, BYTE *bytes, DWORD length, BOOL write,
                          ULONGLONG deadline, HANDLE cancellation);

#endif
