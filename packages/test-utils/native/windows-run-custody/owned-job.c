#include "owned-job.h"

#include <jobapi2.h>

HANDLE dorkos_create_owned_job(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) return NULL;

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                              (DWORD)sizeof(limits)))
    return job;

  DWORD error = GetLastError();
  CloseHandle(job);
  SetLastError(error);
  return NULL;
}
