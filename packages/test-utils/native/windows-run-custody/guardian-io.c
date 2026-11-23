#include "guardian-io.h"

static DWORD wait_budget(ULONGLONG deadline) {
  ULONGLONG now = GetTickCount64();
  if (now >= deadline) return 0;
  ULONGLONG remaining = deadline - now;
  return remaining >= INFINITE ? INFINITE - 1 : (DWORD)remaining;
}

BOOL dorkos_io_is_current(ULONGLONG deadline, HANDLE cancellation) {
  if (cancellation != NULL) {
    DWORD canceled = WaitForSingleObject(cancellation, 0);
    if (canceled == WAIT_OBJECT_0) {
      SetLastError(ERROR_CANCELLED);
      return FALSE;
    }
    if (canceled != WAIT_TIMEOUT) return FALSE;
  }
  if (wait_budget(deadline) != 0) return TRUE;
  SetLastError(ERROR_TIMEOUT);
  return FALSE;
}

BOOL dorkos_finish_io(HANDLE pipe, OVERLAPPED *operation, DWORD *count, ULONGLONG deadline,
                      HANDLE cancellation) {
  HANDLE events[] = {operation->hEvent, cancellation};
  DWORD wait = WaitForMultipleObjects(cancellation == NULL ? 1 : 2, events, FALSE,
                                       wait_budget(deadline));
  if (wait == WAIT_OBJECT_0) return GetOverlappedResult(pipe, operation, count, FALSE);

  DWORD error = ERROR_TIMEOUT;
  if (wait == WAIT_FAILED) error = GetLastError();
  else if (wait == WAIT_OBJECT_0 + 1) error = ERROR_CANCELLED;
  CancelIoEx(pipe, operation);
  if (WaitForSingleObject(operation->hEvent, 1000) != WAIT_OBJECT_0 ||
      (!GetOverlappedResult(pipe, operation, count, FALSE) &&
       GetLastError() == ERROR_IO_INCOMPLETE)) {
    /* Only guardian exit can release an I/O buffer the kernel still owns. */
    ExitProcess(error);
  }
  SetLastError(error);
  return FALSE;
}

BOOL dorkos_pipe_transfer(HANDLE pipe, BYTE *bytes, DWORD length, BOOL write,
                          ULONGLONG deadline, HANDLE cancellation) {
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (event == NULL) return FALSE;
  DWORD offset = 0;
  DWORD error = ERROR_SUCCESS;
  while (offset < length) {
    if (!dorkos_io_is_current(deadline, cancellation) || !ResetEvent(event)) {
      error = GetLastError();
      break;
    }
    OVERLAPPED operation = {0};
    operation.hEvent = event;
    DWORD count = 0;
    DWORD remaining = length - offset;
    BOOL complete = write ? WriteFile(pipe, bytes + offset, remaining, NULL, &operation)
                          : ReadFile(pipe, bytes + offset, remaining, NULL, &operation);
    if (complete)
      complete = GetOverlappedResult(pipe, &operation, &count, FALSE);
    else if (GetLastError() == ERROR_IO_PENDING)
      complete = dorkos_finish_io(pipe, &operation, &count, deadline, cancellation);
    if (!complete) {
      error = GetLastError();
      break;
    }
    if (count == 0 || count > remaining) {
      error = ERROR_INVALID_DATA;
      break;
    }
    offset += count;
  }
  if (!CloseHandle(event) && error == ERROR_SUCCESS) error = GetLastError();
  if (error != ERROR_SUCCESS) SetLastError(error);
  return error == ERROR_SUCCESS;
}
