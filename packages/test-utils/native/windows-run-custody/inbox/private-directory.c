/* Owner-private Windows metadata for a single Vitest run. No subprocess or listener. */
#include "private-directory.h"

#include <aclapi.h>
#include <string.h>
#include <wchar.h>

static DWORD process_user(TOKEN_USER **user) {
  HANDLE token;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) {
    CloseHandle(token);
    return ERROR_BAD_IMPERSONATION_LEVEL;
  }
  DWORD error = GetLastError();
  if (error != ERROR_NO_TOKEN) return error;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();

  DWORD size = 0;
  if (GetTokenInformation(token, TokenUser, NULL, 0, &size)) {
    error = ERROR_INVALID_DATA;
  } else if ((error = GetLastError()) == ERROR_INSUFFICIENT_BUFFER) {
    *user = LocalAlloc(LMEM_FIXED, size);
    if (*user == NULL) error = ERROR_NOT_ENOUGH_MEMORY;
    else if (!GetTokenInformation(token, TokenUser, *user, size, &size)) error = GetLastError();
    else error = IsValidSid((*user)->User.Sid) ? ERROR_SUCCESS : ERROR_INVALID_SID;
  }
  CloseHandle(token);
  return error;
}

static BOOL valid_leaf(LPCWSTR path) {
  const WCHAR *leaf = wcsrchr(path, L'\\');
  const WCHAR prefix[] = L"dorkos-custody-";
  if (!leaf || wcsncmp(leaf + 1, prefix, ARRAYSIZE(prefix) - 1) != 0) return FALSE;
  const WCHAR *id = leaf + ARRAYSIZE(prefix);
  return wcslen(id) == 32 && wcsspn(id, L"0123456789abcdef") == 32;
}

static DWORD local_drive_path(LPCWSTR path) {
  if (!((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\') return ERROR_BAD_PATHNAME;
  for (const WCHAR *part = path + 3; *part; part++) {
    if (*part < 32 || wcschr(L"<>:\"/|?*", *part) != NULL ||
        (*part == L'\\' && (part == path + 3 || part[-1] == L'\\')) ||
        ((*part == L'.' || *part == L' ') && (!part[1] || part[1] == L'\\')))
      return ERROR_BAD_PATHNAME;
  }
  WCHAR drive[] = {path[0], L':', L'\\', L'\0'};
  return GetDriveTypeW(drive) == DRIVE_FIXED ? ERROR_SUCCESS : ERROR_NOT_SUPPORTED;
}

static DWORD canonical_local_directory(HANDLE directory, LPCWSTR path) {
  FILE_ATTRIBUTE_TAG_INFO info;
  DWORD flags;
  if (!GetFileInformationByHandleEx(directory, FileAttributeTagInfo, &info, sizeof(info)) ||
      !GetVolumeInformationByHandleW(directory, NULL, 0, NULL, NULL, &flags, NULL, 0))
    return GetLastError();
  if (!(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || !(flags & FILE_PERSISTENT_ACLS))
    return ERROR_NOT_SUPPORTED;

  const DWORD length = GetFinalPathNameByHandleW(directory, NULL, 0, VOLUME_NAME_DOS);
  if (length == 0) return GetLastError();
  if (length > 32768) return ERROR_FILENAME_EXCED_RANGE;
  WCHAR *final = LocalAlloc(LMEM_FIXED, (SIZE_T)length * sizeof(WCHAR));
  if (final == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  DWORD read = GetFinalPathNameByHandleW(directory, final, length, VOLUME_NAME_DOS);
  DWORD error = ERROR_BAD_PATHNAME;
  if (read == 0) error = GetLastError();
  else if (read < length && wcsncmp(final, L"\\\\?\\", 4) == 0 &&
           CompareStringOrdinal(final + 4, -1, path, -1, TRUE) == CSTR_EQUAL)
    error = ERROR_SUCCESS;
  LocalFree(final);
  return error;
}

static DWORD verified_acl(HANDLE directory, PSID user) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL acl = NULL;
  DWORD error = GetSecurityInfo(directory, SE_FILE_OBJECT,
                               OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                               &owner, NULL, &acl, NULL, &descriptor);
  if (error != ERROR_SUCCESS) return error;

  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision;
  ACCESS_ALLOWED_ACE *ace;
  error = ERROR_ACCESS_DENIED;
  if (owner && IsValidSid(owner) && EqualSid(owner, user) && acl && IsValidAcl(acl) &&
      acl->AceCount == 1 &&
      GetSecurityDescriptorControl(descriptor, &control, &revision) &&
      (control & SE_DACL_PROTECTED) &&
      GetAce(acl, 0, (void **)&ace) && ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
      ace->Header.AceFlags == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) &&
      ace->Mask == FILE_ALL_ACCESS && IsValidSid(&ace->SidStart) && EqualSid(&ace->SidStart, user))
    error = ERROR_SUCCESS;
  LocalFree(descriptor);
  return error;
}

static HANDLE open_directory(LPCWSTR path, DWORD access, DWORD sharing) {
  return CreateFileW(path, access, sharing, NULL, OPEN_EXISTING,
                     FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
}

static DWORD checked_open(LPCWSTR path, BOOL creating, PSID user, HANDLE *result) {
  if (!valid_leaf(path)) return ERROR_BAD_PATHNAME;
  DWORD error = local_drive_path(path);
  if (error != ERROR_SUCCESS) return error;
  DWORD access = FILE_READ_ATTRIBUTES | READ_CONTROL;
  DWORD sharing = FILE_SHARE_READ | FILE_SHARE_WRITE;
  if (creating) access |= DELETE;
  else sharing |= FILE_SHARE_DELETE; /* Permit the owner's existing DELETE handle. */
  HANDLE directory = open_directory(path, access, sharing);
  if (directory == INVALID_HANDLE_VALUE) return GetLastError();
  error = canonical_local_directory(directory, path);
  if (error == ERROR_SUCCESS) error = verified_acl(directory, user);
  if (error == ERROR_SUCCESS) *result = directory;
  else CloseHandle(directory);
  return error;
}

static DWORD create_directory(LPCWSTR path, PSID user) {
  const DWORD bytes = (DWORD)(sizeof(ACL) + FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart)) +
                      GetLengthSid(user);
  PACL acl = LocalAlloc(LMEM_FIXED, bytes);
  if (acl == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), &descriptor, FALSE};
  DWORD error = ERROR_SUCCESS;
  if (!InitializeAcl(acl, bytes, ACL_REVISION) ||
      !AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                             FILE_ALL_ACCESS, user) ||
      !InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptor, user, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED) ||
      !CreateDirectoryW(path, &attributes))
    error = GetLastError();
  LocalFree(acl);
  return error;
}

DWORD dorkos_create_inbox(LPCWSTR path, HANDLE *result, BOOL *created) {
  *created = FALSE;
  if (!valid_leaf(path)) return ERROR_BAD_PATHNAME;
  DWORD error = local_drive_path(path);
  if (error != ERROR_SUCCESS) return error;
  size_t length = (size_t)(wcsrchr(path, L'\\') - path);
  if (length < 3 || length > 32767) return ERROR_BAD_PATHNAME;
  WCHAR *parent = LocalAlloc(LMEM_FIXED, (length + 1) * sizeof(WCHAR));
  if (parent == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  memcpy(parent, path, length * sizeof(WCHAR));
  parent[length] = L'\0';
  HANDLE directory = open_directory(parent, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
  error = directory == INVALID_HANDLE_VALUE ? GetLastError() : canonical_local_directory(directory, parent);
  LocalFree(parent);

  TOKEN_USER *user = NULL;
  if (error == ERROR_SUCCESS) error = process_user(&user);
  if (error == ERROR_SUCCESS) error = create_directory(path, user->User.Sid);
  if (error == ERROR_SUCCESS) {
    *created = TRUE;
    error = checked_open(path, TRUE, user->User.Sid, result);
  }
  if (user != NULL) LocalFree(user);
  if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  return error;
}

DWORD dorkos_open_inbox(LPCWSTR path, HANDLE *result) {
  TOKEN_USER *user = NULL;
  DWORD error = process_user(&user);
  if (error == ERROR_SUCCESS) error = checked_open(path, FALSE, user->User.Sid, result);
  if (user != NULL) LocalFree(user);
  return error;
}

DWORD dorkos_match_inbox(HANDLE directory, LPCWSTR path) {
  HANDLE candidate;
  DWORD error = dorkos_open_inbox(path, &candidate);
  if (error != ERROR_SUCCESS) return error;
  FILE_ID_INFO held, current;
  if (!GetFileInformationByHandleEx(directory, FileIdInfo, &held, sizeof(held)) ||
      !GetFileInformationByHandleEx(candidate, FileIdInfo, &current, sizeof(current)))
    error = GetLastError();
  else if (held.VolumeSerialNumber != current.VolumeSerialNumber ||
           memcmp(held.FileId.Identifier, current.FileId.Identifier, sizeof(held.FileId.Identifier)) != 0)
    error = ERROR_INVALID_DATA;
  CloseHandle(candidate);
  return error;
}

DWORD dorkos_remove_empty_inbox(HANDLE directory) {
  FILE_DISPOSITION_INFO disposition = {TRUE};
  return SetFileInformationByHandle(directory, FileDispositionInfo, &disposition, sizeof(disposition))
             ? ERROR_SUCCESS : GetLastError();
}
