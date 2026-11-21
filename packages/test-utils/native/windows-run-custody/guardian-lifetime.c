#include "guardian-lifetime.h"

#include "guardian-io.h"

#include <jobapi2.h>

enum { JOIN_MS = 5000, IO_CANCEL_MS = 1000, ACCOUNTING_POLL_MS = 25, IMAGE_CAPACITY = 32768 };

typedef struct {
  HANDLE pipe;
  OVERLAPPED operation;
  BYTE byte;
  BOOL pending;
} OwnerWatch;

static BOOL owner_closed(DWORD error) {
  return error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA;
}

static void record_owner_end(DorkosRunResult *result, DWORD error, size_t role) {
  result->error = error;
  if (owner_closed(error))
    result->end = role == 0 ? DORKOS_RUN_MAIN_OWNER_LOST : DORKOS_RUN_SCOPE_OWNER_LOST;
}

static BOOL is_exact_suspended_subject(const DorkosSuspendedTarget *child, LPCWSTR executable) {
  if (child->process.dwProcessId == 0 || child->process.dwProcessId == GetCurrentProcessId() ||
      child->process.dwProcessId != GetProcessId(child->process.hProcess) ||
      child->process.dwThreadId == 0 ||
      child->process.dwThreadId != GetThreadId(child->process.hThread) ||
      child->process.dwProcessId != GetProcessIdOfThread(child->process.hThread)) {
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
  }

  BOOL member = FALSE;
  if (!IsProcessInJob(child->process.hProcess, child->job, &member)) return FALSE;
  DWORD process = WaitForSingleObject(child->process.hProcess, 0);
  if (process == WAIT_FAILED) return FALSE;
  if (!member || process != WAIT_TIMEOUT) {
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
  }

  WCHAR observed[IMAGE_CAPACITY];
  DWORD length = (DWORD)ARRAYSIZE(observed);
  if (!QueryFullProcessImageNameW(child->process.hProcess, 0, observed, &length)) return FALSE;
  int same_image = CompareStringOrdinal(executable, -1, observed, -1, TRUE);
  if (same_image == CSTR_EQUAL) return TRUE;
  if (same_image != 0) SetLastError(ERROR_INVALID_DATA);
  return FALSE;
}

static DWORD begin_watch(OwnerWatch *watch) {
  watch->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (watch->operation.hEvent == NULL) return GetLastError();

  if (ReadFile(watch->pipe, &watch->byte, 1, NULL, &watch->operation))
    return ERROR_INVALID_DATA;
  DWORD error = GetLastError();
  if (error != ERROR_IO_PENDING) return error;
  watch->pending = TRUE;
  return ERROR_SUCCESS;
}

static DWORD observe_watch(OwnerWatch *watch) {
  DWORD count = 0;
  if (GetOverlappedResult(watch->pipe, &watch->operation, &count, FALSE)) {
    watch->pending = FALSE;
    return ERROR_INVALID_DATA;
  }
  DWORD error = GetLastError();
  if (error != ERROR_IO_INCOMPLETE) watch->pending = FALSE;
  return error;
}

static void record_cleanup_error(DorkosRunResult *result, DWORD error) {
  if (result->cleanup_error == ERROR_SUCCESS) result->cleanup_error = error;
}

static void cancel_watches(OwnerWatch watches[2], DorkosRunResult *result) {
  for (size_t i = 0; i < 2; ++i) {
    OwnerWatch *watch = &watches[i];
    if (!watch->pending || CancelIoEx(watch->pipe, &watch->operation)) continue;
    DWORD error = GetLastError();
    if (error != ERROR_NOT_FOUND) record_cleanup_error(result, error);
  }
}

static void finish_watches(OwnerWatch watches[2], DorkosRunResult *result,
                           ULONGLONG deadline) {
  for (size_t i = 0; i < 2; ++i) {
    OwnerWatch *watch = &watches[i];
    if (watch->pending) {
      ULONGLONG now = GetTickCount64();
      DWORD remaining = now < deadline ? (DWORD)(deadline - now) : 0;
      if (WaitForSingleObject(watch->operation.hEvent, remaining) != WAIT_OBJECT_0 ||
          observe_watch(watch) == ERROR_IO_INCOMPLETE) {
        /* Only guardian process exit can safely release these pending I/O buffers. */
        ExitProcess(ERROR_OPERATION_ABORTED);
      }
    }
    if (watch->operation.hEvent != NULL && !CloseHandle(watch->operation.hEvent))
      record_cleanup_error(result, GetLastError());
  }
}

static BOOL active_processes(HANDLE job, DWORD *active) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                 (DWORD)sizeof(accounting), NULL))
    return FALSE;
  *active = accounting.ActiveProcesses;
  return TRUE;
}

static void run_while_owned(const DorkosSuspendedTarget *target, OwnerWatch watches[2],
                            HANDLE stop_event, DorkosRunResult *result) {
  HANDLE observed[4] = {watches[0].operation.hEvent, watches[1].operation.hEvent};
  DWORD watch_count = 2;
  if (stop_event != NULL) observed[watch_count++] = stop_event;
  observed[watch_count] = target->process.hProcess;
  BOOL leader_exited = FALSE;
  for (;;) {
    DWORD count = leader_exited ? watch_count : watch_count + 1;
    DWORD timeout = leader_exited ? ACCOUNTING_POLL_MS : INFINITE;
    DWORD signaled = WaitForMultipleObjects(count, observed, FALSE, timeout);
    if (signaled == WAIT_OBJECT_0 || signaled == WAIT_OBJECT_0 + 1) {
      size_t role = signaled - WAIT_OBJECT_0;
      record_owner_end(result, observe_watch(&watches[role]), role);
      return;
    }
    if (stop_event != NULL && signaled == WAIT_OBJECT_0 + 2) {
      result->end = DORKOS_RUN_STOPPED;
      return;
    }
    if (signaled != WAIT_OBJECT_0 + watch_count && signaled != WAIT_TIMEOUT) {
      result->error = GetLastError();
      return;
    }

    leader_exited = TRUE;
    DWORD active;
    if (!active_processes(target->job, &active)) {
      result->error = GetLastError();
      return;
    }
    if (active == 0) {
      result->end = DORKOS_RUN_COMPLETED;
      return;
    }
  }
}

static void join_job(const DorkosSuspendedTarget *target, DorkosRunResult *result,
                     ULONGLONG deadline) {
  DWORD active = 0;
  BOOL known = active_processes(target->job, &active);
  if (!known) record_cleanup_error(result, GetLastError());
  if ((!known || active != 0) && !TerminateJobObject(target->job, ERROR_CANCELLED))
    record_cleanup_error(result, GetLastError());

  for (;;) {
    ULONGLONG now = GetTickCount64();
    DWORD observed = WaitForSingleObject(target->process.hProcess,
                                        now < deadline ? (DWORD)(deadline - now) : 0);
    if (observed != WAIT_OBJECT_0) {
      record_cleanup_error(result, observed == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError());
      return;
    }
    if (!active_processes(target->job, &active)) {
      record_cleanup_error(result, GetLastError());
      return;
    }
    if (active == 0) {
      if (GetTickCount64() >= deadline) {
        record_cleanup_error(result, ERROR_TIMEOUT);
        return;
      }
      if (GetExitCodeProcess(target->process.hProcess, &result->leader_exit_code))
        result->joined = TRUE;
      else
        record_cleanup_error(result, GetLastError());
      return;
    }
    now = GetTickCount64();
    if (now >= deadline) {
      record_cleanup_error(result, ERROR_TIMEOUT);
      return;
    }
    DWORD remaining = (DWORD)(deadline - now);
    Sleep(remaining < ACCOUNTING_POLL_MS ? remaining : ACCOUNTING_POLL_MS);
  }
}

DorkosRunResult dorkos_run_owned_target(DorkosSuspendedTarget *target, LPCWSTR executable,
                                       DorkosOwnerAttempt *attempt, HANDLE main_pipe,
                                       HANDLE scope_pipe, ULONGLONG confirmation_deadline,
                                       const DorkosGuardianControl *control) {
  DorkosRunResult result = {0};
  DorkosSuspendedTarget child = *target;
  ZeroMemory(target, sizeof(*target));
  OwnerWatch watches[2] = {0};
  ULONGLONG closing_started;
  HANDLE stop_event = control == NULL ? NULL : control->stop_event;
  watches[0].pipe = main_pipe;
  watches[1].pipe = scope_pipe;

  if (!is_exact_suspended_subject(&child, executable) ||
      !dorkos_exchange_owner_attempt(attempt, main_pipe, scope_pipe, DORKOS_OWNER_CONFIRMATION,
                                     confirmation_deadline, stop_event)) {
    result.error = GetLastError();
    goto cleanup;
  }
  for (size_t i = 0; i < ARRAYSIZE(watches); ++i) {
    DWORD error = begin_watch(&watches[i]);
    if (error != ERROR_SUCCESS) {
      record_owner_end(&result, error, i);
      goto cleanup;
    }
  }

  if (!dorkos_io_is_current(confirmation_deadline, stop_event)) {
    result.error = GetLastError();
    goto cleanup;
  }
  HANDLE events[] = {watches[0].operation.hEvent, watches[1].operation.hEvent, stop_event};
  DWORD owner = WaitForMultipleObjects(stop_event == NULL ? 2 : 3, events, FALSE, 0);
  if (owner != WAIT_TIMEOUT) {
    if (owner == WAIT_OBJECT_0 || owner == WAIT_OBJECT_0 + 1) {
      size_t role = owner - WAIT_OBJECT_0;
      record_owner_end(&result, observe_watch(&watches[role]), role);
    } else if (owner == WAIT_OBJECT_0 + 2) {
      result.end = DORKOS_RUN_STOPPED;
    } else {
      result.error = GetLastError();
    }
    goto cleanup;
  }
  DWORD previous = ResumeThread(child.process.hThread);
  if (previous != 1) {
    result.error = previous == (DWORD)-1 ? GetLastError() : ERROR_INVALID_DATA;
    goto cleanup;
  }
  result.resumed = TRUE;
  if (control != NULL && control->publish_spawn != NULL) {
    result.error = control->publish_spawn(&child.process, control->context);
    if (result.error != ERROR_SUCCESS) goto cleanup;
  }
  run_while_owned(&child, watches, stop_event, &result);

cleanup:
  if (result.end == DORKOS_RUN_FAILED && result.error == ERROR_CANCELLED && stop_event != NULL &&
      WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0)
    result.end = DORKOS_RUN_STOPPED;
  closing_started = GetTickCount64();
  dorkos_clear_owner_attempt(attempt);
  cancel_watches(watches, &result);
  join_job(&child, &result, closing_started + JOIN_MS);
  if (!CloseHandle(child.process.hThread)) record_cleanup_error(&result, GetLastError());
  if (!CloseHandle(child.process.hProcess)) record_cleanup_error(&result, GetLastError());
  if (!CloseHandle(child.job)) record_cleanup_error(&result, GetLastError());
  finish_watches(watches, &result, closing_started + IO_CANCEL_MS);
  return result;
}
