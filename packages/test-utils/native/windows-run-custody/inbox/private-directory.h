#ifndef DORKOS_PRIVATE_DIRECTORY_H
#define DORKOS_PRIVATE_DIRECTORY_H

#include <windows.h>

/* These routines work only on a canonical local directory on an ACL volume.
 * A successful create pins the directory against rename until owner close. */
DWORD dorkos_create_inbox(LPCWSTR path, HANDLE *directory, BOOL *created);
DWORD dorkos_open_inbox(LPCWSTR path, HANDLE *directory);
DWORD dorkos_match_inbox(HANDLE directory, LPCWSTR path);
DWORD dorkos_remove_empty_inbox(HANDLE directory);

#endif
