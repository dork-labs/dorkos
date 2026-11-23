#include "../guardian-lifetime.h"
#include "../owner-pipe.h"
#include "../suspended-target.h"

#include <namedpipeapi.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define WIDE_LIMIT 32768
#define CHILD_EXIT 37
#define JOIN_MS 5000

static BOOL announce(const char *line) {
  return puts(line) != EOF && fflush(stdout) != EOF;
}

static int failure(const char *operation) {
  DWORD error = GetLastError();
  fprintf(stderr, "%s failed (Win32 error %lu)\n", operation, (unsigned long)error);
  return 1;
}

static BOOL read_bootstrap(HANDLE input, BYTE *bytes, DWORD length) {
  DWORD offset = 0;
  while (offset < length) {
    DWORD received = 0;
    if (!ReadFile(input, bytes + offset, length - offset, &received, NULL)) return FALSE;
    if (received == 0) {
      SetLastError(ERROR_BROKEN_PIPE);
      return FALSE;
    }
    offset += received;
  }
  return TRUE;
}

static BOOL owner_pipe_is_open_and_empty(HANDLE pipe) {
  DWORD available = 0;
  if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) return FALSE;
  if (available == 0) return TRUE;
  SetLastError(ERROR_INVALID_DATA);
  return FALSE;
}

static BOOL is_suspended_subject(const DorkosSuspendedTarget *child, LPCWSTR executable) {
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
  if (!member || WaitForSingleObject(child->process.hProcess, 0) != WAIT_TIMEOUT) {
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
  }
  WCHAR observed[WIDE_LIMIT];
  DWORD length = (DWORD)ARRAYSIZE(observed);
  if (!QueryFullProcessImageNameW(child->process.hProcess, 0, observed, &length)) return FALSE;
  if (CompareStringOrdinal(executable, -1, observed, -1, TRUE) == CSTR_EQUAL) return TRUE;
  SetLastError(ERROR_INVALID_DATA);
  return FALSE;
}

static int close_unstarted_subject(DorkosSuspendedTarget child) {
  int status = 0;
  if (!CloseHandle(child.job)) status = failure("Close owned Job");
  DWORD observed = WaitForSingleObject(child.process.hProcess, JOIN_MS);
  if (observed != WAIT_OBJECT_0) {
    fputs("Job close did not join the actual witness subject.\n", stderr);
    status = 1;
    /* Only recover the private test child described by our retained handle. */
    DWORD id = GetProcessId(child.process.hProcess);
    if (id != 0 && id != GetCurrentProcessId() && id == child.process.dwProcessId) {
      TerminateProcess(child.process.hProcess, ERROR_CANCELLED);
      if (WaitForSingleObject(child.process.hProcess, JOIN_MS) != WAIT_OBJECT_0)
        fputs("Fixture recovery did not join the subject.\n", stderr);
    }
  } else {
    DWORD code;
    if (!GetExitCodeProcess(child.process.hProcess, &code))
      status = failure("Read actual subject exit");
    else if (code == CHILD_EXIT) {
      fputs("Unexpected execution verdict from the actual witness subject.\n", stderr);
      status = 1;
    }
  }
  if (!CloseHandle(child.process.hThread)) status = failure("Close actual subject thread");
  if (!CloseHandle(child.process.hProcess)) status = failure("Close actual subject process");
  return status;
}

static int run_attempt(HANDLE input, HANDLE main_pipe, HANDLE scope_pipe,
                       DorkosOwnerAttempt *attempt, LPCWSTR mode) {
  if (!announce("ready")) return 1;
  ULONGLONG admission = GetTickCount64() + 10000;
  if (!dorkos_connect_owner_attempt_pipe(main_pipe, admission, NULL) ||
      !dorkos_connect_owner_attempt_pipe(scope_pipe, admission, NULL))
    return failure("Connect both owner roles");

  if (!dorkos_exchange_owner_attempt(attempt, main_pipe, scope_pipe, DORKOS_OWNER_ADMISSION,
                                    admission, NULL)) {
    if (GetLastError() == ERROR_ACCESS_DENIED)
      return announce("admission-refused") ? 0 : 1;
    return failure("Authenticate owner admission");
  }

  if (!owner_pipe_is_open_and_empty(main_pipe) || !owner_pipe_is_open_and_empty(scope_pipe))
    return failure("Check current owners before creating the subject");

  WCHAR executable[WIDE_LIMIT];
  DWORD image_length = GetModuleFileNameW(NULL, executable, (DWORD)ARRAYSIZE(executable));
  if (image_length == 0 || image_length >= (DWORD)ARRAYSIZE(executable))
    return failure("Resolve exact witness image");
  WCHAR cwd[WIDE_LIMIT];
  DWORD cwd_length = GetCurrentDirectoryW((DWORD)ARRAYSIZE(cwd), cwd);
  if (cwd_length == 0 || cwd_length >= (DWORD)ARRAYSIZE(cwd))
    return failure("Resolve witness working folder");
  WCHAR command[WIDE_LIMIT];
  if (swprintf(command, ARRAYSIZE(command), L"\"%ls\" %ls", executable, mode) < 0)
    return 1;
  WCHAR environment[] = L"DORKOS_RUN_CUSTODY_WITNESS=1\0";
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (nul == INVALID_HANDLE_VALUE) return failure("Open fixture stdio");
  const DorkosTargetStdio stdio_handles = {nul, GetStdHandle(STD_OUTPUT_HANDLE), nul};
  DorkosSuspendedTarget child;
  BOOL created = dorkos_create_suspended_target(executable, command, cwd, environment,
                                                 &stdio_handles, &child);
  DWORD error = created ? ERROR_SUCCESS : GetLastError();
  CloseHandle(nul);
  if (!created) {
    SetLastError(error);
    return failure("Create suspended witness subject");
  }

  BYTE continue_byte = 0;
  if (!is_suspended_subject(&child, executable)) {
    int status = failure("Observe exact suspended Job subject");
    if (close_unstarted_subject(child) != 0) status = 1;
    return status;
  }
  if (!announce("prepared") || !read_bootstrap(input, &continue_byte, 1) ||
      continue_byte != 'g') {
    close_unstarted_subject(child);
    return 1;
  }

  HANDLE self = GetCurrentProcess();
  HANDLE observed_target;
  if (!DuplicateHandle(self, child.process.hProcess, self, &observed_target,
                       SYNCHRONIZE | PROCESS_TERMINATE, FALSE, 0)) {
    int status = failure("Retain witness target observation handle");
    if (close_unstarted_subject(child) != 0) status = 1;
    return status;
  }

  DWORD target_pid = child.process.dwProcessId;
  DorkosRunResult result = dorkos_run_owned_target(&child, executable, attempt, main_pipe,
                                                 scope_pipe, GetTickCount64() + JOIN_MS, NULL);
  DWORD observed = WaitForSingleObject(observed_target, 0);
  if (observed != WAIT_OBJECT_0 || result.cleanup_error != ERROR_SUCCESS || !result.joined) {
    SetLastError(result.cleanup_error != ERROR_SUCCESS ? result.cleanup_error : ERROR_INVALID_DATA);
    int status = failure("Join exact target and empty Job");
    /* Recover only this directly created fixture child after preserving the failure. */
    if (observed == WAIT_TIMEOUT) {
      TerminateProcess(observed_target, ERROR_CANCELLED);
      if (WaitForSingleObject(observed_target, JOIN_MS) != WAIT_OBJECT_0)
        fputs("Fixture recovery did not join its actual target.\n", stderr);
    }
    CloseHandle(observed_target);
    return status;
  }
  if (!CloseHandle(observed_target)) return failure("Close witness target observation handle");
  if (printf("joined %lu %d %d %lu %lu %lu\n", (unsigned long)target_pid,
             (int)result.end, result.resumed != FALSE, (unsigned long)result.leader_exit_code,
             (unsigned long)result.error, (unsigned long)result.cleanup_error) < 0 ||
      fflush(stdout) != 0) return 1;
  if (!result.resumed &&
      (result.error == ERROR_BROKEN_PIPE || result.error == ERROR_PIPE_NOT_CONNECTED ||
       result.error == ERROR_NO_DATA) && result.leader_exit_code != CHILD_EXIT)
    return announce("owner-lost-before-resume") ? 0 : 1;
  if (result.resumed && result.end == DORKOS_RUN_COMPLETED && result.leader_exit_code == CHILD_EXIT)
    return announce("resumed") ? 0 : 1;
  if (result.resumed &&
      result.leader_exit_code ==
          (DWORD)(wcscmp(mode, L"--leader-subject") == 0 ? CHILD_EXIT : ERROR_CANCELLED)) {
    if (result.end == DORKOS_RUN_MAIN_OWNER_LOST) return announce("main-owner-closed") ? 0 : 1;
    if (result.end == DORKOS_RUN_SCOPE_OWNER_LOST) return announce("scope-owner-closed") ? 0 : 1;
  }
  SetLastError(result.error != ERROR_SUCCESS ? result.error : ERROR_INVALID_DATA);
  return failure("Check exact witness operation outcome");
}

static int start_owned_descendant(LPCWSTR executable) {
  HANDLE self = GetCurrentProcess();
  HANDLE leader;
  if (!DuplicateHandle(self, self, self, &leader, SYNCHRONIZE, TRUE, 0))
    return failure("Get exact leader wait handle");

  HANDLE inherited[] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE),
                        GetStdHandle(STD_ERROR_HANDLE), leader};
  WCHAR command[WIDE_LIMIT];
  if (swprintf(command, ARRAYSIZE(command), L"\"%ls\" --descendant-subject %llu", executable,
               (unsigned long long)(uintptr_t)leader) < 0) {
    CloseHandle(leader);
    return 1;
  }

  SIZE_T bytes = 0;
  BOOL sized = InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  if (sized || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    if (sized) SetLastError(ERROR_INVALID_DATA);
    DWORD error = GetLastError();
    CloseHandle(leader);
    SetLastError(error);
    return failure("Size fixture descendant inheritance list");
  }
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (attributes == NULL) {
    CloseHandle(leader);
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return failure("Allocate fixture descendant inheritance list");
  }
  BOOL initialized = InitializeProcThreadAttributeList(attributes, 1, 0, &bytes);
  DWORD error = ERROR_SUCCESS;
  BOOL created = FALSE;
  PROCESS_INFORMATION descendant = {0};
  if (initialized &&
      UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                sizeof(inherited), NULL, NULL)) {
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = (DWORD)sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes;
    created = CreateProcessW(executable, command, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT,
                             NULL, NULL, &startup.StartupInfo, &descendant);
  }
  if (!created) error = GetLastError();
  if (initialized) DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  CloseHandle(leader);
  if (!created) {
    SetLastError(error);
    return failure("Create ordinary descendant inside the inherited Job");
  }
  CloseHandle(descendant.hThread);
  CloseHandle(descendant.hProcess);
  return CHILD_EXIT;
}

static int stay_live(const char *marker) {
  if (!announce(marker)) return 1;
  /* A watchdog keeps the inert fixture finite even if its expected owner action fails. */
  Sleep(15000);
  return 1;
}

static int report_architecture(void) {
  HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  if (kernel == NULL) return failure("Resolve Windows process architecture API");
  FARPROC address = GetProcAddress(kernel, "IsWow64Process2");
  if (address == NULL) return failure("Query native Windows architecture");
  typedef BOOL (WINAPI *ArchitectureProbe)(HANDLE, USHORT *, USHORT *);
  ArchitectureProbe query;
  _Static_assert(sizeof(query) == sizeof(address), "Windows API function pointer size");
  CopyMemory(&query, &address, sizeof(query));
  USHORT process = 0;
  USHORT native = 0;
  if (!query(GetCurrentProcess(), &process, &native))
    return failure("Read exact fixture process and host architectures");
  return printf("%u %u\n", (unsigned int)process, (unsigned int)native) < 0 ? 1 : 0;
}

int wmain(int argc, WCHAR **argv) {
  if (argc == 2 && wcscmp(argv[1], L"--report-architecture") == 0)
    return report_architecture();
  if (argc == 2 && wcscmp(argv[1], L"--inert-subject") == 0) return CHILD_EXIT;
  if (argc == 2 && wcscmp(argv[1], L"--long-subject") == 0) return stay_live("target-running");
  if (argc == 2 && wcscmp(argv[1], L"--leader-subject") == 0)
    return start_owned_descendant(argv[0]);
  if (argc == 3 && wcscmp(argv[1], L"--descendant-subject") == 0) {
    WCHAR *end = NULL;
    unsigned long long value = _wcstoui64(argv[2], &end, 10);
    if (value == 0 || value > (unsigned long long)UINTPTR_MAX || *end != L'\0') return 2;
    HANDLE leader = (HANDLE)(uintptr_t)value;
    DWORD observed = WaitForSingleObject(leader, JOIN_MS);
    CloseHandle(leader);
    if (observed != WAIT_OBJECT_0) return 2;
    return stay_live("descendant-running-after-leader-exit");
  }

  LPCWSTR mode = L"--inert-subject";
  if (argc == 2 && wcscmp(argv[1], L"--hold-target") == 0) mode = L"--long-subject";
  else if (argc == 2 && wcscmp(argv[1], L"--hold-descendant") == 0) mode = L"--leader-subject";
  else if (argc != 1) return 2;

  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  BYTE bootstrap[2 * DORKOS_OWNER_BINDING_BYTES + 2 * DORKOS_OWNER_CAPABILITY_BYTES];
  if (!read_bootstrap(input, bootstrap, (DWORD)sizeof(bootstrap))) return failure("Read fixture bootstrap");
  DorkosOwnerAttempt attempt;
  BOOL initialized = dorkos_init_owner_attempt(&attempt, bootstrap, bootstrap + 16,
                                               bootstrap + 32, bootstrap + 64);
  DWORD error = initialized ? ERROR_SUCCESS : GetLastError();
  SecureZeroMemory(bootstrap, sizeof(bootstrap));
  if (!initialized) {
    SetLastError(error);
    return failure("Initialize owner attempt");
  }

  WCHAR scope_name[33] = {0};
  const WCHAR hex[] = L"0123456789abcdef";
  for (size_t i = 0; i < sizeof(attempt.scope); ++i) {
    scope_name[i * 2] = hex[attempt.scope[i] >> 4];
    scope_name[i * 2 + 1] = hex[attempt.scope[i] & 0xf];
  }
  HANDLE main_pipe = dorkos_create_owner_pipe(scope_name, DORKOS_MAIN_OWNER);
  int status;
  if (main_pipe == INVALID_HANDLE_VALUE) {
    status = failure("Create private main pipe");
  } else {
    HANDLE scope_pipe = dorkos_create_owner_pipe(scope_name, DORKOS_SCOPE_OWNER);
    if (scope_pipe == INVALID_HANDLE_VALUE) {
      status = failure("Create private scope pipe");
    } else {
      status = run_attempt(input, main_pipe, scope_pipe, &attempt, mode);
      if (!CloseHandle(scope_pipe)) status = failure("Close private scope pipe");
    }
    if (!CloseHandle(main_pipe)) status = failure("Close private main pipe");
  }
  dorkos_clear_owner_attempt(&attempt);
  if (status != 0) return status;
  return announce("closed") ? 0 : 1;
}
