#include "guardian-io.h"
#include "guardian-lifetime.h"
#include "owner-pipe.h"

#include <io.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

enum {
  HEADER_BYTES = 28,
  BINDING_BYTES = 2 * DORKOS_OWNER_BINDING_BYTES + 2 * DORKOS_OWNER_CAPABILITY_BYTES,
  START_BUDGET_MS = 5000,
  MAX_START_MS = 300000,
  REPORT_MS = 500,
  REPORT_MAGIC = 0x31524744,
  READY = 1,
  SPAWNED = 2,
  TERMINAL = 3,
  NEVER_ACQUIRED = 1,
  SPAWN_FAILED = 2,
  COMPLETED = 3,
  STOPPED = 4,
  MAIN_LOST = 5,
  SCOPE_LOST = 6,
  FAILED = 7,
};

typedef struct {
  WCHAR *storage;
  DWORD bytes;
  DWORD startup_ms;
  DWORD stdio_mask;
  LPCWSTR executable;
  LPCWSTR cwd;
  LPWSTR command;
  LPWSTR environment;
  DorkosOwnerAttempt attempt;
} Request;

typedef struct {
  HANDLE pipe;
  OVERLAPPED operation;
  BYTE command;
} StopRead;

typedef struct {
  HANDLE pipe;
  OVERLAPPED operation;
  DWORD words[8];
  BOOL pending;
} Reporter;

static DWORD read_word(const BYTE *bytes) {
  return (DWORD)bytes[0] | ((DWORD)bytes[1] << 8) | ((DWORD)bytes[2] << 16) |
         ((DWORD)bytes[3] << 24);
}

static BOOL path_is_absolute(LPCWSTR path) {
  return (((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
             path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) ||
         (path[0] == L'\\' && path[1] == L'\\' && path[2] != L'\0');
}

static BOOL has_terminator(LPCWSTR value, DWORD size) {
  for (DWORD i = 0; i + 1 < size; ++i) {
    if (value[i] == L'\0') return FALSE;
  }
  return value[size - 1] == L'\0';
}

static BOOL read_request(HANDLE input, ULONGLONG deadline, Request *request) {
  BYTE header[HEADER_BYTES];
  if (!dorkos_pipe_transfer(input, header, (DWORD)sizeof(header), FALSE, deadline, NULL))
    return FALSE;
  request->startup_ms = read_word(header + 4);
  request->stdio_mask = read_word(header + 8);
  DWORD exe = read_word(header + 12);
  DWORD cwd = read_word(header + 16);
  DWORD command = read_word(header + 20);
  DWORD environment = read_word(header + 24);
  if (memcmp(header, "DKG1", 4) != 0 || request->startup_ms == 0 ||
      request->startup_ms > MAX_START_MS || request->stdio_mask > 7 ||
      exe < 4 || exe > 32767 || cwd < 4 || cwd > 32767 || command < 2 || command > 32767 ||
      environment < 2 || environment > 131072) {
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
  }

  request->bytes = BINDING_BYTES + (exe + cwd + command + environment) * (DWORD)sizeof(WCHAR);
  request->storage = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, request->bytes);
  if (request->storage == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return FALSE;
  }
  BYTE *bytes = (BYTE *)request->storage;
  if (!dorkos_pipe_transfer(input, bytes, request->bytes, FALSE, deadline, NULL)) return FALSE;
  request->executable = (LPCWSTR)(bytes + BINDING_BYTES);
  request->cwd = request->executable + exe;
  request->command = request->storage + BINDING_BYTES / sizeof(WCHAR) + exe + cwd;
  request->environment = request->command + command;
  if (!has_terminator(request->executable, exe) || !path_is_absolute(request->executable) ||
      !has_terminator(request->cwd, cwd) || !path_is_absolute(request->cwd) ||
      !has_terminator(request->command, command) ||
      request->environment[environment - 1] != L'\0' ||
      request->environment[environment - 2] != L'\0') {
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
  }
  for (DWORD i = 0; i + 2 < environment; ++i) {
    if (request->environment[i] == L'\0' && request->environment[i + 1] == L'\0') {
      SetLastError(ERROR_INVALID_DATA);
      return FALSE;
    }
  }
  BOOL initialized = dorkos_init_owner_attempt(&request->attempt, bytes, bytes + 16,
                                               bytes + 32, bytes + 64);
  DWORD error = initialized ? ERROR_SUCCESS : GetLastError();
  SecureZeroMemory(bytes, BINDING_BYTES);
  if (!initialized) SetLastError(error);
  return initialized;
}

static BOOL begin_stop_read(StopRead *stop) {
  stop->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (stop->operation.hEvent == NULL) return FALSE;
  BOOL read = ReadFile(stop->pipe, &stop->command, 1, NULL, &stop->operation);
  if (read) return SetEvent(stop->operation.hEvent);
  return GetLastError() == ERROR_IO_PENDING;
}

static DWORD stop_result(StopRead *stop, BOOL requested) {
  if (stop->operation.hEvent == NULL) return ERROR_SUCCESS;
  DWORD count = 0;
  if (requested) {
    if (!GetOverlappedResult(stop->pipe, &stop->operation, &count, FALSE)) return GetLastError();
    return count == 1 && stop->command == 1 ? ERROR_SUCCESS : ERROR_INVALID_DATA;
  }
  CancelIoEx(stop->pipe, &stop->operation);
  if (WaitForSingleObject(stop->operation.hEvent, REPORT_MS) != WAIT_OBJECT_0 ||
      (!GetOverlappedResult(stop->pipe, &stop->operation, &count, FALSE) &&
       GetLastError() == ERROR_IO_INCOMPLETE))
    ExitProcess(ERROR_OPERATION_ABORTED);
  return ERROR_SUCCESS;
}

static DWORD publish_spawn(const PROCESS_INFORMATION *process, void *context) {
  Reporter *reporter = context;
  reporter->words[0] = REPORT_MAGIC;
  reporter->words[1] = SPAWNED;
  reporter->words[4] = process->dwProcessId;
  BOOL complete = WriteFile(reporter->pipe, reporter->words, (DWORD)sizeof(reporter->words), NULL,
                            &reporter->operation);
  if (!complete) {
    DWORD error = GetLastError();
    if (error != ERROR_IO_PENDING) return error;
    reporter->pending = TRUE;
    return ERROR_SUCCESS;
  }
  DWORD count = 0;
  if (!GetOverlappedResult(reporter->pipe, &reporter->operation, &count, FALSE)) return GetLastError();
  return count == (DWORD)sizeof(reporter->words) ? ERROR_SUCCESS : ERROR_WRITE_FAULT;
}

static BOOL finish_spawn_report(Reporter *reporter, ULONGLONG deadline) {
  if (!reporter->pending) return TRUE;
  DWORD count = 0;
  return dorkos_finish_io(reporter->pipe, &reporter->operation, &count, deadline, NULL) &&
         count == (DWORD)sizeof(reporter->words);
}

static BOOL report(HANDLE pipe, DWORD kind, DWORD outcome, DWORD flags, DWORD error,
                   DWORD cleanup_error, DWORD exit_code, ULONGLONG deadline, HANDLE cancellation) {
  DWORD words[8] = {REPORT_MAGIC, kind, outcome, flags, 0, error, cleanup_error, exit_code};
  return dorkos_pipe_transfer(pipe, (BYTE *)words, (DWORD)sizeof(words), TRUE, deadline, cancellation);
}

static void close_target_stdio(HANDLE streams[3], DWORD mask, DWORD *error) {
  for (int i = 0; i < 3; ++i) {
    if (streams[i] == NULL || streams[i] == INVALID_HANDLE_VALUE) continue;
    if ((mask & (1u << i)) != 0) {
      if (_close(i + 3) != 0 && *error == ERROR_SUCCESS) *error = ERROR_INVALID_HANDLE;
    } else if (!CloseHandle(streams[i]) && *error == ERROR_SUCCESS) {
      *error = GetLastError();
    }
    streams[i] = NULL;
  }
}

static BOOL open_target_stdio(HANDLE streams[3], DWORD mask) {
  for (int i = 0; i < 3; ++i) {
    if ((mask & (1u << i)) != 0) {
      intptr_t fd = _get_osfhandle(i + 3);
      if (fd == -1 || fd == -2) {
        SetLastError(ERROR_INVALID_HANDLE);
        return FALSE;
      }
      streams[i] = (HANDLE)fd;
    } else {
      streams[i] = CreateFileW(L"NUL", i == 0 ? GENERIC_READ : GENERIC_WRITE,
                               FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                               FILE_ATTRIBUTE_NORMAL, NULL);
      if (streams[i] == INVALID_HANDLE_VALUE) return FALSE;
    }
  }
  return TRUE;
}

static void close_owned_handle(HANDLE handle, DWORD *error) {
  if (handle != NULL && handle != INVALID_HANDLE_VALUE && !CloseHandle(handle) &&
      *error == ERROR_SUCCESS)
    *error = GetLastError();
}

static DWORD run_end(DorkosRunEnd end) {
  switch (end) {
    case DORKOS_RUN_COMPLETED: return COMPLETED;
    case DORKOS_RUN_STOPPED: return STOPPED;
    case DORKOS_RUN_MAIN_OWNER_LOST: return MAIN_LOST;
    case DORKOS_RUN_SCOPE_OWNER_LOST: return SCOPE_LOST;
    case DORKOS_RUN_FAILED: return FAILED;
  }
  return FAILED;
}

int wmain(int argc, WCHAR **argv) {
  (void)argv;
  if (argc != 1) return 2;
  ULONGLONG started = GetTickCount64();
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (GetFileType(input) != FILE_TYPE_PIPE || GetFileType(output) != FILE_TYPE_PIPE) return 2;

  Request request = {0};
  Reporter reporter = {0};
  reporter.pipe = output;
  StopRead stop = {0};
  stop.pipe = input;
  BOOL stop_started = FALSE;
  HANDLE main_pipe = INVALID_HANDLE_VALUE;
  HANDLE scope_pipe = INVALID_HANDLE_VALUE;
  HANDLE streams[3] = {0};
  DWORD outcome = NEVER_ACQUIRED;
  DWORD error = ERROR_SUCCESS;
  DWORD cleanup_error = ERROR_SUCCESS;
  DWORD flags = 0;
  DWORD exit_code = 0;
  ULONGLONG deadline;

  if (!read_request(input, started + START_BUDGET_MS, &request)) goto failed;
  deadline = started + request.startup_ms;
  if (!begin_stop_read(&stop)) goto failed;
  stop_started = TRUE;
  if (!dorkos_io_is_current(deadline, stop.operation.hEvent)) goto failed;

  WCHAR scope_name[33] = {0};
  const WCHAR hex[] = L"0123456789abcdef";
  for (size_t i = 0; i < sizeof(request.attempt.scope); ++i) {
    scope_name[i * 2] = hex[request.attempt.scope[i] >> 4];
    scope_name[i * 2 + 1] = hex[request.attempt.scope[i] & 15];
  }
  main_pipe = dorkos_create_owner_pipe(scope_name, DORKOS_MAIN_OWNER);
  if (main_pipe == INVALID_HANDLE_VALUE) goto failed;
  scope_pipe = dorkos_create_owner_pipe(scope_name, DORKOS_SCOPE_OWNER);
  if (scope_pipe == INVALID_HANDLE_VALUE) goto failed;

  if (!report(output, READY, 0, 0, 0, 0, 0, deadline, stop.operation.hEvent) ||
      !dorkos_connect_owner_attempt_pipe(main_pipe, deadline, stop.operation.hEvent) ||
      !dorkos_connect_owner_attempt_pipe(scope_pipe, deadline, stop.operation.hEvent) ||
      !dorkos_exchange_owner_attempt(&request.attempt, main_pipe, scope_pipe,
                                     DORKOS_OWNER_ADMISSION, deadline, stop.operation.hEvent))
    goto failed;

  reporter.operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (reporter.operation.hEvent == NULL || !open_target_stdio(streams, request.stdio_mask) ||
      !dorkos_io_is_current(deadline, stop.operation.hEvent))
    goto failed;

  DorkosTargetStdio stdio = {streams[0], streams[1], streams[2]};
  DorkosSuspendedTarget target;
  if (!dorkos_create_suspended_target(request.executable, request.command, request.cwd,
                                     request.environment, &stdio, &target)) {
    outcome = SPAWN_FAILED;
    goto failed;
  }
  close_target_stdio(streams, request.stdio_mask, &cleanup_error);
  size_t used_bytes = (size_t)((BYTE *)request.command - (BYTE *)request.storage);
  SecureZeroMemory(request.command, request.bytes - used_bytes);

  DorkosGuardianControl control = {stop.operation.hEvent, publish_spawn, &reporter};
  DorkosRunResult result = dorkos_run_owned_target(&target, request.executable, &request.attempt,
                                                  main_pipe, scope_pipe, deadline, &control);
  outcome = run_end(result.end);
  flags = 1u | (result.resumed ? 2u : 0u) | (result.joined ? 4u : 0u);
  error = result.error;
  if (cleanup_error == ERROR_SUCCESS) cleanup_error = result.cleanup_error;
  exit_code = result.leader_exit_code;
  goto closing;

failed:
  error = GetLastError();
  if (error == ERROR_CANCELLED && stop_started &&
      WaitForSingleObject(stop.operation.hEvent, 0) == WAIT_OBJECT_0)
    outcome = STOPPED;

closing:
  if (stop_started) {
    DWORD stop_error = stop_result(&stop, outcome == STOPPED);
    if (outcome == STOPPED && stop_error != ERROR_SUCCESS) {
      outcome = flags == 0 ? NEVER_ACQUIRED : FAILED;
      error = stop_error;
    }
  }
  close_owned_handle(stop.operation.hEvent, &cleanup_error);
  close_target_stdio(streams, request.stdio_mask, &cleanup_error);
  close_owned_handle(scope_pipe, &cleanup_error);
  close_owned_handle(main_pipe, &cleanup_error);
  dorkos_clear_owner_attempt(&request.attempt);
  if (request.storage != NULL) {
    SecureZeroMemory(request.storage, request.bytes);
    HeapFree(GetProcessHeap(), 0, request.storage);
  }

  deadline = GetTickCount64() + REPORT_MS;
  BOOL reported = finish_spawn_report(&reporter, deadline);
  close_owned_handle(reporter.operation.hEvent, &cleanup_error);
  if (!reported || !report(output, TERMINAL, outcome, flags, error, cleanup_error, exit_code,
                           deadline, NULL))
    return 1;
  return 0;
}
