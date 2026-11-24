/* The test runner and its worker can each hold a real, non-inheritable directory
 * handle. Loading this module creates nothing and starts no helper. */
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include "private-directory.h"

typedef struct {
  HANDLE directory;
  BOOL creator;
} InboxLease;

static const napi_type_tag lease_tag = {0xad22b00b110e4552ULL, 0xaf20488c91551339ULL};

static napi_value failure(napi_env env, const char *operation, DWORD error) {
  char message[144];
  snprintf(message, sizeof(message), "%s failed (Win32 %lu)", operation, (unsigned long)error);
  napi_throw_error(env, "DORKOS_PRIVATE_INBOX", message);
  return NULL;
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  InboxLease *lease = data;
  if (lease->directory != INVALID_HANDLE_VALUE) CloseHandle(lease->directory);
  LocalFree(lease);
}

static WCHAR *path_arg(napi_env env, napi_value value) {
  size_t length, copied;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length < 4 || length > 32767) {
    napi_throw_type_error(env, NULL, "Expected a canonical local Windows directory path");
    return NULL;
  }
  WCHAR *path = LocalAlloc(LMEM_FIXED, (length + 1) * sizeof(WCHAR));
  if (path == NULL) {
    failure(env, "Allocate custody path", ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (napi_get_value_string_utf16(env, value, (char16_t *)path, length + 1, &copied) != napi_ok ||
      copied != length || wcslen(path) != length) {
    LocalFree(path);
    napi_throw_type_error(env, NULL, "Invalid custody directory path");
    return NULL;
  }
  return path;
}

static BOOL args(napi_env env, napi_callback_info info, napi_value *argv, size_t expected) {
  size_t actual = expected;
  if (napi_get_cb_info(env, info, &actual, argv, NULL, NULL) == napi_ok && actual == expected)
    return TRUE;
  napi_throw_type_error(env, NULL, "Missing custody directory argument");
  return FALSE;
}

static napi_value acquire(napi_env env, napi_callback_info info, BOOL create) {
  napi_value arg, holder;
  if (!args(env, info, &arg, 1)) return NULL;
  WCHAR *path = path_arg(env, arg);
  if (path == NULL) return NULL;
  InboxLease *lease = LocalAlloc(LMEM_FIXED, sizeof(*lease));
  if (lease == NULL) {
    LocalFree(path);
    return failure(env, "Allocate custody lease", ERROR_NOT_ENOUGH_MEMORY);
  }
  lease->creator = create;
  lease->directory = INVALID_HANDLE_VALUE;
  BOOL created = FALSE;
  DWORD error = create ? dorkos_create_inbox(path, &lease->directory, &created)
                       : dorkos_open_inbox(path, &lease->directory);
  LocalFree(path);
  if (error != ERROR_SUCCESS) {
    LocalFree(lease);
    /* Never clean an unverified directory by path after a partial creation. */
    if (created) return failure(env, "Verify newly created custody inbox (retained)", error);
    return failure(env, create ? "Create private custody inbox" : "Open private custody inbox", error);
  }
  if (napi_create_object(env, &holder) != napi_ok ||
      napi_type_tag_object(env, holder, &lease_tag) != napi_ok ||
      napi_wrap(env, holder, lease, finalize, NULL, NULL) != napi_ok) {
    if (create) dorkos_remove_empty_inbox(lease->directory);
    finalize(env, lease, NULL);
    return failure(env, "Wrap custody lease", ERROR_NOT_ENOUGH_MEMORY);
  }
  return holder;
}

static napi_value create_inbox(napi_env env, napi_callback_info info) {
  return acquire(env, info, TRUE);
}

static napi_value open_inbox(napi_env env, napi_callback_info info) {
  return acquire(env, info, FALSE);
}

static InboxLease *get_lease(napi_env env, napi_value value, BOOL allow_closed) {
  bool valid = false;
  InboxLease *lease = NULL;
  if (napi_check_object_type_tag(env, value, &lease_tag, &valid) != napi_ok || !valid ||
      napi_unwrap(env, value, (void **)&lease) != napi_ok || lease == NULL) {
    napi_throw_type_error(env, NULL, "Expected this module's custody directory lease");
    return NULL;
  }
  if (!allow_closed && lease->directory == INVALID_HANDLE_VALUE) {
    failure(env, "Use custody lease", ERROR_INVALID_HANDLE);
    return NULL;
  }
  return lease;
}

static napi_value verify(napi_env env, napi_callback_info info) {
  napi_value argv[2], value;
  if (!args(env, info, argv, 2)) return NULL;
  InboxLease *lease = get_lease(env, argv[0], FALSE);
  if (lease == NULL) return NULL;
  WCHAR *path = path_arg(env, argv[1]);
  if (path == NULL) return NULL;
  DWORD error = dorkos_match_inbox(lease->directory, path);
  LocalFree(path);
  if (error != ERROR_SUCCESS) return failure(env, "Verify private custody inbox", error);
  if (napi_get_undefined(env, &value) != napi_ok) return NULL;
  return value;
}

static napi_value identity(napi_env env, napi_callback_info info) {
  napi_value arg, value;
  if (!args(env, info, &arg, 1)) return NULL;
  InboxLease *lease = get_lease(env, arg, FALSE);
  if (lease == NULL) return NULL;
  FILE_ID_INFO id;
  if (!GetFileInformationByHandleEx(lease->directory, FileIdInfo, &id, sizeof(id)))
    return failure(env, "Read custody directory identity", GetLastError());
  BYTE bytes[sizeof(id.VolumeSerialNumber) + sizeof(id.FileId.Identifier)];
  memcpy(bytes, &id.VolumeSerialNumber, sizeof(id.VolumeSerialNumber));
  memcpy(bytes + sizeof(id.VolumeSerialNumber), id.FileId.Identifier, sizeof(id.FileId.Identifier));
  if (napi_create_buffer_copy(env, sizeof(bytes), bytes, NULL, &value) != napi_ok)
    return failure(env, "Copy custody directory identity", ERROR_NOT_ENOUGH_MEMORY);
  return value;
}

static napi_value release(napi_env env, napi_callback_info info, BOOL remove) {
  napi_value arg, value;
  if (!args(env, info, &arg, 1)) return NULL;
  InboxLease *lease = get_lease(env, arg, !remove);
  if (lease == NULL) return NULL;
  if (remove) {
    if (!lease->creator) return failure(env, "Remove custody inbox", ERROR_ACCESS_DENIED);
    DWORD error = dorkos_remove_empty_inbox(lease->directory);
    if (error != ERROR_SUCCESS) return failure(env, "Remove empty custody inbox", error);
  }
  if (lease->directory != INVALID_HANDLE_VALUE) {
    if (!CloseHandle(lease->directory)) return failure(env, "Close custody lease", GetLastError());
    lease->directory = INVALID_HANDLE_VALUE;
  }
  if (napi_get_undefined(env, &value) != napi_ok) return NULL;
  return value;
}

static napi_value close_inbox(napi_env env, napi_callback_info info) {
  return release(env, info, FALSE);
}

static napi_value remove_inbox(napi_env env, napi_callback_info info) {
  return release(env, info, TRUE);
}

static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"create", NULL, create_inbox, NULL, NULL, NULL, napi_default, NULL},
    {"open", NULL, open_inbox, NULL, NULL, NULL, napi_default, NULL},
    {"verify", NULL, verify, NULL, NULL, NULL, napi_default, NULL},
    {"identity", NULL, identity, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, close_inbox, NULL, NULL, NULL, napi_default, NULL},
    {"removeEmpty", NULL, remove_inbox, NULL, NULL, NULL, napi_default, NULL}
  };
  if (napi_define_properties(env, exports, ARRAYSIZE(methods), methods) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
