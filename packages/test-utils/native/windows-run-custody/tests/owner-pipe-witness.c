#include "../owner-pipe.h"

#include <namedpipeapi.h>
#include <stdio.h>

#define IO_MS 5000
#define CANCEL_MS 1000

static int win32_failure(const char *operation) {
  fprintf(stderr, "%s failed (Win32 error %lu)\n", operation,
          (unsigned long)GetLastError());
  return 1;
}

static BOOL report(const char *line) {
  return puts(line) != EOF && fflush(stdout) != EOF;
}

/* Own one operation's event and buffer until completion, including timeout. */
static BOOL complete_io(HANDLE pipe, OVERLAPPED *operation, DWORD *transferred) {
  DWORD result = WaitForSingleObject(operation->hEvent, IO_MS);
  if (result == WAIT_OBJECT_0)
    return GetOverlappedResult(pipe, operation, transferred, FALSE);

  DWORD error = result == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
  CancelIoEx(pipe, operation);
  if (WaitForSingleObject(operation->hEvent, CANCEL_MS) != WAIT_OBJECT_0) {
    /* The fixture owns this process and has no target. Do not unwind a pending buffer. */
    ExitProcess(error);
  }
  GetOverlappedResult(pipe, operation, transferred, FALSE);
  SetLastError(error);
  return FALSE;
}

static BOOL connect_owner(HANDLE pipe) {
  OVERLAPPED operation = {0};
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (operation.hEvent == NULL) return FALSE;

  BOOL connected = ConnectNamedPipe(pipe, &operation);
  if (!connected) {
    DWORD error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
    else if (error == ERROR_IO_PENDING) {
      DWORD transferred = 0;
      connected = complete_io(pipe, &operation, &transferred);
    }
  }
  DWORD error = connected ? ERROR_SUCCESS : GetLastError();
  CloseHandle(operation.hEvent);
  if (!connected) SetLastError(error);
  return connected;
}

static BOOL read_owner(HANDLE pipe, char expected, BOOL expect_close) {
  OVERLAPPED operation = {0};
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (operation.hEvent == NULL) return FALSE;

  char message = 0;
  DWORD count = 0;
  BOOL read = ReadFile(pipe, &message, 1, NULL, &operation);
  if (read) read = GetOverlappedResult(pipe, &operation, &count, FALSE);
  else if (GetLastError() == ERROR_IO_PENDING)
    read = complete_io(pipe, &operation, &count);
  DWORD error = read ? ERROR_SUCCESS : GetLastError();
  CloseHandle(operation.hEvent);

  if (expect_close && !read &&
      (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED))
    return TRUE;
  if (!expect_close && read && count == 1 && message == expected)
    return dorkos_check_owner_pipe_identity(pipe);
  SetLastError(error == ERROR_SUCCESS ? ERROR_INVALID_DATA : error);
  return FALSE;
}

static int witness(HANDLE main_pipe, HANDLE scope_pipe) {
  DWORD main_flags = 0;
  DWORD scope_flags = 0;
  if (!GetHandleInformation(main_pipe, &main_flags) ||
      !GetHandleInformation(scope_pipe, &scope_flags))
    return win32_failure("GetHandleInformation");
  if (((main_flags | scope_flags) & HANDLE_FLAG_INHERIT) != 0) {
    fputs("An owner server pipe was inheritable.\n", stderr);
    return 1;
  }
  if (!report("ready")) return 1;
  if (!connect_owner(main_pipe)) return win32_failure("ConnectNamedPipe (main)");
  if (!connect_owner(scope_pipe)) return win32_failure("ConnectNamedPipe (scope)");
  if (!read_owner(main_pipe, 'm', FALSE)) return win32_failure("Read and identify main owner");
  if (!read_owner(scope_pipe, 's', FALSE)) return win32_failure("Read and identify scope owner");
  if (!report("both-observed")) return 1;
  if (!read_owner(main_pipe, 0, TRUE)) return win32_failure("Observe main close");
  if (!report("main-closed")) return 1;
  if (!read_owner(scope_pipe, 'r', FALSE)) return win32_failure("Observe independent live scope");
  if (!report("scope-live")) return 1;
  if (!read_owner(scope_pipe, 0, TRUE)) return win32_failure("Observe scope close");
  return 0;
}

int wmain(int argc, WCHAR **argv) {
  if (argc != 2) return 2;
  HANDLE main_pipe = dorkos_create_owner_pipe(argv[1], DORKOS_MAIN_OWNER);
  if (main_pipe == INVALID_HANDLE_VALUE) return win32_failure("Create main owner pipe");
  HANDLE scope_pipe = dorkos_create_owner_pipe(argv[1], DORKOS_SCOPE_OWNER);
  int status = 0;
  if (scope_pipe == INVALID_HANDLE_VALUE) {
    status = win32_failure("Create scope owner pipe");
  } else {
    HANDLE duplicate = dorkos_create_owner_pipe(argv[1], DORKOS_MAIN_OWNER);
    if (duplicate != INVALID_HANDLE_VALUE) {
      fputs("A second guardian could create the same main endpoint.\n", stderr);
      CloseHandle(duplicate);
      status = 1;
    } else if (GetLastError() != ERROR_ACCESS_DENIED) {
      status = win32_failure("Create duplicate main endpoint (expected refusal)");
    } else {
      status = witness(main_pipe, scope_pipe);
    }
    if (!CloseHandle(scope_pipe)) status = win32_failure("Close scope owner pipe");
  }
  if (!CloseHandle(main_pipe)) status = win32_failure("Close main owner pipe");
  if (status != 0) return status;
  return report("closed") ? 0 : 1;
}
