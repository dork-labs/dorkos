#ifndef DORKOS_WINDOWS_RUN_CUSTODY_OWNED_JOB_H
#define DORKOS_WINDOWS_RUN_CUSTODY_OWNED_JOB_H

#include <windows.h>

/*
 * Create the guardian's unnamed, non-inheritable Job with close-time cleanup
 * enabled. The caller owns the only returned handle and must close it.
 * NULL preserves the Windows error from the failed creation or configuration.
 */
HANDLE dorkos_create_owned_job(void);

#endif
