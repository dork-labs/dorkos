#include "suspended-target.h"

#include "owned-job.h"
#include <handleapi.h>
#include <processthreadsapi.h>

/* Only standard I/O objects can enter the inheritance list. */
static BOOL duplicate_stdio(HANDLE input, HANDLE *copy) {
  SetLastError(ERROR_SUCCESS);
  DWORD kind = GetFileType(input);
  if (kind != FILE_TYPE_CHAR && kind != FILE_TYPE_DISK && kind != FILE_TYPE_PIPE) {
    if (GetLastError() == ERROR_SUCCESS) SetLastError(ERROR_INVALID_HANDLE);
    return FALSE;
  }

  HANDLE self = GetCurrentProcess();
  return DuplicateHandle(self, input, self, copy, 0, TRUE, DUPLICATE_SAME_ACCESS);
}

BOOL dorkos_create_suspended_target(LPCWSTR executable, LPWSTR command_line,
                                    LPCWSTR cwd, WCHAR *environment,
                                    const DorkosTargetStdio *stdio_handles,
                                    DorkosSuspendedTarget *target) {
  if (target == NULL) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return FALSE;
  }
  ZeroMemory(target, sizeof(*target));
  if (executable == NULL || *executable == L'\0' || command_line == NULL ||
      cwd == NULL || *cwd == L'\0' || environment == NULL || stdio_handles == NULL) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return FALSE;
  }

  HANDLE sources[] = {stdio_handles->input, stdio_handles->output, stdio_handles->error};
  HANDLE inherited[3] = {0};
  HANDLE job = NULL;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  BOOL initialized = FALSE;
  BOOL created = FALSE;
  DWORD error = ERROR_SUCCESS;
  PROCESS_INFORMATION process = {0};
  STARTUPINFOEXW startup = {0};

  for (size_t i = 0; i < ARRAYSIZE(inherited); ++i) {
    if (!duplicate_stdio(sources[i], &inherited[i])) goto cleanup;
  }

  job = dorkos_create_owned_job();
  if (job == NULL) goto cleanup;

  SIZE_T attribute_bytes = 0;
  /* The Windows sizing call fails with the required buffer size. */
  if (InitializeProcThreadAttributeList(NULL, 2, 0, &attribute_bytes)) {
    SetLastError(ERROR_INVALID_DATA);
    goto cleanup;
  }
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) goto cleanup;
  attributes = HeapAlloc(GetProcessHeap(), 0, attribute_bytes);
  if (attributes == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    goto cleanup;
  }
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_bytes)) goto cleanup;
  initialized = TRUE;

  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 inherited, sizeof(inherited), NULL, NULL) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job, sizeof(job), NULL, NULL))
    goto cleanup;

  startup.StartupInfo.cb = (DWORD)sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  startup.lpAttributeList = attributes;
  created = CreateProcessW(executable, command_line, NULL, NULL, TRUE,
                           EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                               CREATE_UNICODE_ENVIRONMENT,
                           environment, cwd, &startup.StartupInfo, &process);

cleanup:
  if (!created) error = GetLastError();
  if (initialized) DeleteProcThreadAttributeList(attributes);
  if (attributes != NULL) HeapFree(GetProcessHeap(), 0, attributes);
  for (size_t i = 0; i < ARRAYSIZE(inherited); ++i) {
    if (inherited[i] != NULL) CloseHandle(inherited[i]);
  }
  if (!created) {
    if (job != NULL) CloseHandle(job);
    SetLastError(error);
    return FALSE;
  }

  target->job = job;
  target->process = process;
  return TRUE;
}
