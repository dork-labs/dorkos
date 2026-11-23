#include "../owned-job.h"

#include <handleapi.h>
#include <jobapi2.h>
#include <stdio.h>

static int report_win32_failure(const char *operation) {
  DWORD error = GetLastError();
  fprintf(stderr, "%s failed (Win32 error %lu)\n", operation,
          (unsigned long)error);
  return 1;
}

static int check_owned_job(HANDLE job) {
  DWORD handle_flags = HANDLE_FLAG_INHERIT;
  if (!GetHandleInformation(job, &handle_flags))
    return report_win32_failure("GetHandleInformation");
  if ((handle_flags & HANDLE_FLAG_INHERIT) != 0) {
    fputs("The returned Job handle is inheritable.\n", stderr);
    return 1;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  DWORD bytes = 0;
  if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                                 (DWORD)sizeof(limits), &bytes))
    return report_win32_failure("QueryInformationJobObject (limits)");
  if (bytes != (DWORD)sizeof(limits) ||
      limits.BasicLimitInformation.LimitFlags != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) {
    fprintf(stderr, "Unexpected Job limits (bytes %lu, flags 0x%lx).\n",
            (unsigned long)bytes,
            (unsigned long)limits.BasicLimitInformation.LimitFlags);
    return 1;
  }

  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
  bytes = 0;
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &accounting, (DWORD)sizeof(accounting), &bytes))
    return report_win32_failure("QueryInformationJobObject (accounting)");
  if (bytes != (DWORD)sizeof(accounting) || accounting.ActiveProcesses != 0 ||
      accounting.TotalProcesses != 0) {
    fprintf(stderr, "Unexpected Job accounting (bytes %lu, active %lu, total %lu).\n",
            (unsigned long)bytes, (unsigned long)accounting.ActiveProcesses,
            (unsigned long)accounting.TotalProcesses);
    return 1;
  }
  return 0;
}

int main(void) {
  HANDLE job = dorkos_create_owned_job();
  if (job == NULL) return report_win32_failure("dorkos_create_owned_job");

  int status = check_owned_job(job);
  if (!CloseHandle(job)) return report_win32_failure("CloseHandle");
  if (status != 0) return status;
  if (puts("Verified and closed a non-inheritable, empty Job with close-time cleanup.") == EOF ||
      fflush(stdout) == EOF)
    return 1;
  return 0;
}
