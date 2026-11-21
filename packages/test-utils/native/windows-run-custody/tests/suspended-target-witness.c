#include "../suspended-target.h"

#include <handleapi.h>
#include <jobapi2.h>
#include <processthreadsapi.h>
#include <stdio.h>
#include <wchar.h>

#define WIDE_LIMIT 32768
#define CHILD_EXIT 17
#define JOIN_MS 5000

static int win32_failure(const char *task) {
  DWORD error = GetLastError();
  fprintf(stderr, "%s failed (Win32 error %lu)\n", task, (unsigned long)error);
  return 1;
}

static int unexpected(const char *message) {
  fprintf(stderr, "%s\n", message);
  return 1;
}

static int check_suspended_target(const WCHAR *expected_image,
                                  const DorkosSuspendedTarget *target) {
  const PROCESS_INFORMATION *process = &target->process;
  if (process->dwProcessId == 0 || process->dwProcessId == GetCurrentProcessId() ||
      GetProcessId(process->hProcess) != process->dwProcessId ||
      process->dwThreadId == 0 || GetThreadId(process->hThread) != process->dwThreadId)
    return unexpected("The returned handles did not name the actual child.");

  WCHAR image[WIDE_LIMIT];
  DWORD length = (DWORD)ARRAYSIZE(image);
  if (!QueryFullProcessImageNameW(process->hProcess, 0, image, &length))
    return win32_failure("QueryFullProcessImageNameW");
  if (CompareStringOrdinal(image, -1, expected_image, -1, TRUE) != CSTR_EQUAL)
    return unexpected("The actual child image differed from the selected executable.");

  DWORD flags = 0;
  if (!GetHandleInformation(target->job, &flags))
    return win32_failure("GetHandleInformation (Job)");
  if ((flags & HANDLE_FLAG_INHERIT) != 0)
    return unexpected("The guardian Job handle was inheritable.");

  BOOL member = FALSE;
  if (!IsProcessInJob(process->hProcess, target->job, &member))
    return win32_failure("IsProcessInJob");
  if (!member) return unexpected("The actual suspended child was outside the Job.");

  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
  DWORD bytes = 0;
  if (!QueryInformationJobObject(target->job, JobObjectBasicAccountingInformation,
                                 &accounting, (DWORD)sizeof(accounting), &bytes))
    return win32_failure("QueryInformationJobObject");
  if (bytes != (DWORD)sizeof(accounting) || accounting.ActiveProcesses != 1 ||
      accounting.TotalProcesses != 1)
    return unexpected("The Job did not contain exactly one live target.");

  /* Observe the prior suspension count. The witness never resumes the thread. */
  DWORD previous = SuspendThread(process->hThread);
  if (previous == (DWORD)-1) return win32_failure("SuspendThread");
  if (previous != 1) return unexpected("The primary thread was not created suspended.");
  return 0;
}

/* The kernel Job check remains failed even when this fixture recovery succeeds. */
static void recover_fixture_subject(const PROCESS_INFORMATION *process) {
  DWORD state = WaitForSingleObject(process->hProcess, 0);
  if (state == WAIT_OBJECT_0) return;
  if (state != WAIT_TIMEOUT) {
    if (state == WAIT_FAILED) win32_failure("WaitForSingleObject (fixture recovery check)");
    else unexpected("Fixture recovery could not observe the retained process.");
    return;
  }

  DWORD child_id = GetProcessId(process->hProcess);
  if (child_id == 0 || child_id == GetCurrentProcessId() || child_id != process->dwProcessId) {
    unexpected("Fixture recovery could not confirm the retained child handle.");
    return;
  }
  BOOL stopped = TerminateProcess(process->hProcess, ERROR_CANCELLED);
  DWORD stop_error = stopped ? ERROR_SUCCESS : GetLastError();
  state = WaitForSingleObject(process->hProcess, JOIN_MS);
  if (state == WAIT_OBJECT_0) return;

  DWORD join_error = state == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
  if (!stopped) {
    SetLastError(stop_error);
    win32_failure("TerminateProcess (fixture recovery)");
  }
  if (state == WAIT_FAILED) {
    SetLastError(join_error);
    win32_failure("WaitForSingleObject (fixture recovery join)");
  } else {
    unexpected("Fixture recovery did not confirm the retained child's exit.");
  }
}

static int close_job_and_join(DorkosSuspendedTarget *target) {
  int status = 0;
  if (!CloseHandle(target->job)) {
    status = win32_failure("CloseHandle (Job)");
  } else {
    DWORD result = WaitForSingleObject(target->process.hProcess, JOIN_MS);
    if (result == WAIT_FAILED) status = win32_failure("WaitForSingleObject (target)");
    else if (result != WAIT_OBJECT_0)
      status = unexpected("Closing the last Job handle left the target live.");
    else {
      DWORD code = 0;
      if (!GetExitCodeProcess(target->process.hProcess, &code))
        status = win32_failure("GetExitCodeProcess");
      else if (code == CHILD_EXIT)
        status = unexpected("The suspended child's test branch executed.");
    }
  }
  if (status != 0) recover_fixture_subject(&target->process);
  if (!CloseHandle(target->process.hThread)) status = win32_failure("CloseHandle (thread)");
  if (!CloseHandle(target->process.hProcess)) status = win32_failure("CloseHandle (target)");
  return status;
}

static int check_failed_create(const WCHAR *image, const WCHAR *cwd, WCHAR *environment,
                               const DorkosTargetStdio *stdio_handles) {
  WCHAR missing[WIDE_LIMIT];
  if (swprintf(missing, ARRAYSIZE(missing), L"%ls.dorkos-custody-absent", image) < 0)
    return unexpected("The missing-target fixture path was too long.");
  if (GetFileAttributesW(missing) != INVALID_FILE_ATTRIBUTES ||
      GetLastError() != ERROR_FILE_NOT_FOUND)
    return unexpected("The missing-target fixture did not have an absent executable.");

  HANDLE self = GetCurrentProcess();
  DWORD before = 0;
  if (!GetProcessHandleCount(self, &before)) return win32_failure("GetProcessHandleCount (before)");
  DorkosSuspendedTarget target;
  WCHAR line[] = L"missing-custody-target";
  if (dorkos_create_suspended_target(missing, line, cwd, environment, stdio_handles, &target)) {
    int status = unexpected("The missing executable started.");
    close_job_and_join(&target);
    return status;
  }
  if (GetLastError() != ERROR_FILE_NOT_FOUND)
    return win32_failure("CreateProcessW (expected ERROR_FILE_NOT_FOUND)");
  if (target.job != NULL || target.process.hProcess != NULL || target.process.hThread != NULL ||
      target.process.dwProcessId != 0 || target.process.dwThreadId != 0)
    return unexpected("A failed launch transferred ownership.");

  DWORD after = 0;
  if (!GetProcessHandleCount(self, &after)) return win32_failure("GetProcessHandleCount (after)");
  if (before != after) return unexpected("A failed launch leaked a handle.");
  return 0;
}

static int witness(HANDLE input, HANDLE output) {
  WCHAR executable[WIDE_LIMIT];
  DWORD image_length = GetModuleFileNameW(NULL, executable, (DWORD)ARRAYSIZE(executable));
  if (image_length == 0 || image_length >= (DWORD)ARRAYSIZE(executable))
    return win32_failure("GetModuleFileNameW");
  WCHAR cwd[WIDE_LIMIT];
  DWORD cwd_length = GetCurrentDirectoryW((DWORD)ARRAYSIZE(cwd), cwd);
  if (cwd_length == 0 || cwd_length >= (DWORD)ARRAYSIZE(cwd))
    return win32_failure("GetCurrentDirectoryW");
  WCHAR line[WIDE_LIMIT];
  if (swprintf(line, ARRAYSIZE(line), L"\"%ls\" --suspended-subject", executable) < 0)
    return unexpected("The witness command line was too long.");
  WCHAR environment[] = L"DORKOS_RUN_CUSTODY_WITNESS=1\0";
  DorkosTargetStdio handles = {input, output, output};
  DorkosSuspendedTarget target;
  if (!dorkos_create_suspended_target(executable, line, cwd, environment, &handles, &target))
    return win32_failure("dorkos_create_suspended_target");

  int check = check_suspended_target(executable, &target);
  int joined = close_job_and_join(&target);
  if (check != 0 || joined != 0) return 1;

  if (check_failed_create(executable, cwd, environment, &handles) != 0) return 1;

  DWORD input_flags = 0;
  DWORD output_flags = 0;
  if (!GetHandleInformation(input, &input_flags) || !GetHandleInformation(output, &output_flags))
    return win32_failure("GetHandleInformation (borrowed stdio)");
  if (((input_flags | output_flags) & HANDLE_FLAG_INHERIT) != 0)
    return unexpected("The caller's borrowed stdio became inheritable.");
  return 0;
}

int wmain(int argc, WCHAR **argv) {
  if (argc == 2 && wcscmp(argv[1], L"--suspended-subject") == 0) return CHILD_EXIT;
  if (argc != 1) return unexpected("Unexpected witness arguments.");

  HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (input == INVALID_HANDLE_VALUE) return win32_failure("CreateFileW (stdin)");
  HANDLE output = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  int status = output == INVALID_HANDLE_VALUE
                   ? win32_failure("CreateFileW (stdout)")
                   : witness(input, output);
  if (output != INVALID_HANDLE_VALUE && !CloseHandle(output))
    status = win32_failure("CloseHandle (stdout)");
  if (!CloseHandle(input)) status = win32_failure("CloseHandle (stdin)");
  if (status != 0) return status;
  if (puts("Verified suspended Job assignment, target join and failed-create cleanup.") == EOF ||
      fflush(stdout) == EOF)
    return 1;
  return 0;
}
