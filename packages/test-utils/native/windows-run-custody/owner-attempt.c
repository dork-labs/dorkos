#include "owner-attempt.h"

#include "guardian-io.h"
#include "owner-pipe.h"
#include <bcrypt.h>
#include <namedpipeapi.h>
#include <string.h>

enum {
  VERSION = 1,
  CHALLENGE = 1,
  RESPONSE = 2,
  ACCEPTED = 3,
  SCOPE_OFFSET = 4,
  ATTEMPT_OFFSET = 20,
  NONCE_OFFSET = 36,
  TAG_OFFSET = 68,
  FRAME_BYTES = TAG_OFFSET + DORKOS_OWNER_CAPABILITY_BYTES,
};

static BOOL matches(const BYTE *left, const BYTE *right, size_t count) {
  volatile unsigned int difference = 0;
  for (size_t i = 0; i < count; ++i) difference |= (unsigned int)(left[i] ^ right[i]);
  return difference == 0;
}

void dorkos_clear_owner_attempt(DorkosOwnerAttempt *attempt) {
  SecureZeroMemory(attempt, sizeof(*attempt));
}

BOOL dorkos_init_owner_attempt(DorkosOwnerAttempt *attempt, const BYTE *scope_id,
                              const BYTE *attempt_id, const BYTE *main_capability,
                              const BYTE *scope_capability) {
  if (attempt != NULL) dorkos_clear_owner_attempt(attempt);
  if (attempt == NULL || scope_id == NULL || attempt_id == NULL ||
      main_capability == NULL || scope_capability == NULL ||
      matches(main_capability, scope_capability, DORKOS_OWNER_CAPABILITY_BYTES)) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return FALSE;
  }
  memcpy(attempt->scope, scope_id, sizeof(attempt->scope));
  memcpy(attempt->attempt, attempt_id, sizeof(attempt->attempt));
  memcpy(attempt->capabilities[0], main_capability, sizeof(attempt->capabilities[0]));
  memcpy(attempt->capabilities[1], scope_capability, sizeof(attempt->capabilities[1]));
  attempt->next_phase = DORKOS_OWNER_ADMISSION;
  return TRUE;
}

BOOL dorkos_connect_owner_attempt_pipe(HANDLE pipe, ULONGLONG deadline, HANDLE cancellation) {
  if (!dorkos_io_is_current(deadline, cancellation)) return FALSE;
  OVERLAPPED operation = {0};
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (operation.hEvent == NULL) return FALSE;
  BOOL connected = ConnectNamedPipe(pipe, &operation);
  if (!connected) {
    DWORD error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
    else if (error == ERROR_IO_PENDING) {
      DWORD transferred = 0;
      connected = dorkos_finish_io(pipe, &operation, &transferred, deadline, cancellation);
    }
  }
  DWORD error = connected ? ERROR_SUCCESS : GetLastError();
  CloseHandle(operation.hEvent);
  if (!connected) SetLastError(error);
  return connected;
}

static BOOL tag_frame(BCRYPT_ALG_HANDLE algorithm, BYTE *capability, BYTE *frame) {
  if (BCryptHash(algorithm, capability, DORKOS_OWNER_CAPABILITY_BYTES, frame,
                 TAG_OFFSET, frame + TAG_OFFSET, DORKOS_OWNER_CAPABILITY_BYTES) == 0)
    return TRUE;
  SetLastError(ERROR_INVALID_DATA);
  return FALSE;
}

static BOOL challenge(BCRYPT_ALG_HANDLE algorithm, DorkosOwnerAttempt *attempt,
                      size_t owner, BYTE phase, BYTE *frame) {
  frame[0] = VERSION;
  frame[1] = phase;
  frame[2] = (BYTE)(owner + 1);
  frame[3] = CHALLENGE;
  memcpy(frame + SCOPE_OFFSET, attempt->scope, sizeof(attempt->scope));
  memcpy(frame + ATTEMPT_OFFSET, attempt->attempt, sizeof(attempt->attempt));
  if (BCryptGenRandom(NULL, frame + NONCE_OFFSET, TAG_OFFSET - NONCE_OFFSET,
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
  }
  return tag_frame(algorithm, attempt->capabilities[owner], frame);
}

BOOL dorkos_exchange_owner_attempt(DorkosOwnerAttempt *attempt, HANDLE main_pipe,
                                  HANDLE scope_pipe, BYTE phase, ULONGLONG deadline,
                                  HANDLE cancellation) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  HANDLE pipes[2] = {main_pipe, scope_pipe};
  BYTE frames[2][FRAME_BYTES] = {0};
  BYTE received[FRAME_BYTES] = {0};
  BOOL accepted = FALSE;
  DWORD error = ERROR_SUCCESS;

  if (attempt == NULL ||
      (phase != DORKOS_OWNER_ADMISSION && phase != DORKOS_OWNER_CONFIRMATION) ||
      attempt->next_phase != phase || main_pipe == scope_pipe) {
    SetLastError(ERROR_INVALID_PARAMETER);
    goto cleanup;
  }
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL,
                                  BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0) {
    SetLastError(ERROR_INVALID_DATA);
    goto cleanup;
  }
  for (size_t owner = 0; owner < ARRAYSIZE(pipes); ++owner) {
    if (!challenge(algorithm, attempt, owner, phase, frames[owner]) ||
        !dorkos_pipe_transfer(pipes[owner], frames[owner], FRAME_BYTES, TRUE, deadline, cancellation))
      goto cleanup;
  }
  for (size_t owner = 0; owner < ARRAYSIZE(pipes); ++owner) {
    if (!dorkos_pipe_transfer(pipes[owner], received, FRAME_BYTES, FALSE, deadline, cancellation)) goto cleanup;
    frames[owner][3] = RESPONSE;
    if (!tag_frame(algorithm, attempt->capabilities[owner], frames[owner])) goto cleanup;
    if (!matches(received, frames[owner], FRAME_BYTES)) {
      SetLastError(ERROR_ACCESS_DENIED);
      goto cleanup;
    }
    if (!dorkos_check_owner_pipe_identity(pipes[owner])) goto cleanup;
  }
  for (size_t owner = 0; owner < ARRAYSIZE(pipes); ++owner) {
    frames[owner][3] = ACCEPTED;
    if (!tag_frame(algorithm, attempt->capabilities[owner], frames[owner]) ||
        !dorkos_pipe_transfer(pipes[owner], frames[owner], FRAME_BYTES, TRUE, deadline, cancellation))
      goto cleanup;
  }
  if (!dorkos_io_is_current(deadline, cancellation)) goto cleanup;
  accepted = TRUE;

cleanup:
  if (!accepted) error = GetLastError();
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  SecureZeroMemory(frames, sizeof(frames));
  SecureZeroMemory(received, sizeof(received));
  if (accepted && phase == DORKOS_OWNER_ADMISSION)
    attempt->next_phase = DORKOS_OWNER_CONFIRMATION;
  else if (attempt != NULL)
    dorkos_clear_owner_attempt(attempt);
  if (!accepted) SetLastError(error);
  return accepted;
}
