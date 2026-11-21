#include "owner-pipe.h"

#include <namedpipeapi.h>
#include <securitybaseapi.h>
#include <strsafe.h>

typedef struct {
  TOKEN_USER *user;
  TOKEN_GROUPS *logon;
} OwnerIdentity;

static void release_identity(OwnerIdentity identity) {
  HANDLE heap = GetProcessHeap();
  if (identity.logon != NULL) HeapFree(heap, 0, identity.logon);
  if (identity.user != NULL) HeapFree(heap, 0, identity.user);
}

static void *read_token_value(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0;
  if (GetTokenInformation(token, kind, NULL, 0, &bytes)) {
    SetLastError(ERROR_INVALID_DATA);
    return NULL;
  }
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) return NULL;

  HANDLE heap = GetProcessHeap();
  void *value = HeapAlloc(heap, 0, bytes);
  if (value == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (GetTokenInformation(token, kind, value, bytes, &bytes)) return value;

  DWORD error = GetLastError();
  HeapFree(heap, 0, value);
  SetLastError(error);
  return NULL;
}

static BOOL read_identity(HANDLE token, OwnerIdentity *identity) {
  identity->user = read_token_value(token, TokenUser);
  if (identity->user == NULL) return FALSE;
  identity->logon = read_token_value(token, TokenLogonSid);
  if (identity->logon == NULL) return FALSE;
  if (identity->logon->GroupCount != 1 ||
      (identity->logon->Groups[0].Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID ||
      !IsValidSid(identity->user->User.Sid) || !IsValidSid(identity->logon->Groups[0].Sid)) {
    SetLastError(ERROR_INVALID_SID);
    return FALSE;
  }
  return TRUE;
}

static BOOL guardian_identity(OwnerIdentity *identity) {
  HANDLE impersonation;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &impersonation)) {
    CloseHandle(impersonation);
    SetLastError(ERROR_BAD_IMPERSONATION_LEVEL);
    return FALSE;
  }
  if (GetLastError() != ERROR_NO_TOKEN) return FALSE;

  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return FALSE;
  BOOL read = read_identity(token, identity);
  DWORD error = read ? ERROR_SUCCESS : GetLastError();
  CloseHandle(token);
  if (!read) SetLastError(error);
  return read;
}

static BOOL valid_scope_id(LPCWSTR scope_id) {
  if (scope_id == NULL) return FALSE;
  for (size_t i = 0; i < 32; ++i) {
    WCHAR value = scope_id[i];
    if ((value < L'0' || value > L'9') && (value < L'a' || value > L'f')) return FALSE;
  }
  return scope_id[32] == L'\0';
}

HANDLE dorkos_create_owner_pipe(LPCWSTR scope_id, DorkosOwnerRole role) {
  WCHAR name[96];
  if (!valid_scope_id(scope_id) || (role != DORKOS_MAIN_OWNER && role != DORKOS_SCOPE_OWNER) ||
      FAILED(StringCchPrintfW(name, ARRAYSIZE(name), L"\\\\.\\pipe\\dorkos-run-custody-%ls-%ls",
                              scope_id, role == DORKOS_MAIN_OWNER ? L"main" : L"scope"))) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return INVALID_HANDLE_VALUE;
  }

  OwnerIdentity guardian = {0};
  HANDLE pipe = INVALID_HANDLE_VALUE;
  DWORD error = ERROR_SUCCESS;
  PACL acl = NULL;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes = {(DWORD)sizeof(attributes), &descriptor, FALSE};
  if (!guardian_identity(&guardian)) goto cleanup;

  PSID logon = guardian.logon->Groups[0].Sid;
  DWORD acl_bytes = (DWORD)(sizeof(ACL) + FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart)) +
                    GetLengthSid(logon);
  acl = HeapAlloc(GetProcessHeap(), 0, acl_bytes);
  if (acl == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    goto cleanup;
  }
  /* Node's duplex pipe client opens with generic read and write. Only this
   * logon receives that access, and one first instance owns this scope name. */
  if (!InitializeAcl(acl, acl_bytes, ACL_REVISION) ||
      !AddAccessAllowedAce(acl, ACL_REVISION, FILE_GENERIC_READ | FILE_GENERIC_WRITE, logon) ||
      !InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptor, guardian.user->User.Sid, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE))
    goto cleanup;

  pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE |
                                    FILE_FLAG_OVERLAPPED,
                          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                              PIPE_REJECT_REMOTE_CLIENTS,
                          1, 4096, 4096, 0, &attributes);

cleanup:
  if (pipe == INVALID_HANDLE_VALUE) error = GetLastError();
  if (acl != NULL) HeapFree(GetProcessHeap(), 0, acl);
  release_identity(guardian);
  if (pipe == INVALID_HANDLE_VALUE) SetLastError(error);
  return pipe;
}

BOOL dorkos_check_owner_pipe_identity(HANDLE pipe) {
  OwnerIdentity guardian = {0};
  OwnerIdentity client = {0};
  HANDLE token = NULL;
  BOOL matched = FALSE;
  DWORD error = ERROR_SUCCESS;

  if (!guardian_identity(&guardian) || !ImpersonateNamedPipeClient(pipe)) {
    error = GetLastError();
    goto cleanup;
  }
  if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token) ||
      !read_identity(token, &client)) {
    error = GetLastError();
  } else {
    matched = EqualSid(guardian.user->User.Sid, client.user->User.Sid) &&
              EqualSid(guardian.logon->Groups[0].Sid, client.logon->Groups[0].Sid);
    if (!matched) error = ERROR_ACCESS_DENIED;
  }

  /* Continuing under the peer identity would violate guardian ownership. */
  if (!RevertToSelf()) ExitProcess(GetLastError());

cleanup:
  if (token != NULL) CloseHandle(token);
  release_identity(client);
  release_identity(guardian);
  if (!matched) SetLastError(error);
  return matched;
}
