#include "guardian.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

unsigned long long guardian_ms(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time)) _exit(70);
  return (unsigned long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}
static int ready(struct guardian *g, int fd, short operation, unsigned long long end) {
  for (;;) {
    if (guardian_ms() >= end) return 0;
    struct pollfd fds[2] = {{fd, operation, 0}, {STDIN_FILENO, POLLIN, 0}};
    int observed = poll(fds, 2, 10);
    if (observed < 0) { if (errno == EINTR) continue; return 0; }
    if (fds[1].revents) { g->control_lost = true; return 0; }
    if (fds[0].revents & operation) return 1;
    if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) return 0;
  }
}
int guardian_read(struct guardian *g, int fd, char *text, size_t size, unsigned long long end) {
  size_t length = 0;
  while (length + 1 < size) {
    if (!ready(g, fd, POLLIN, end)) return 0;
    char byte; ssize_t read_size = read(fd, &byte, 1);
    if (read_size < 0 && errno == EINTR) continue;
    if (read_size != 1 || !byte || byte == '\r') return 0;
    if (byte == '\n') { text[length] = 0; return 1; }
    text[length++] = byte;
  }
  return 0;
}
int guardian_write(struct guardian *g, int fd, const char *text, unsigned long long end) {
  size_t length = strlen(text), sent = 0;
  if (length > 639 || fd < 0) return 0;
  while (sent < length) {
    if (!ready(g, fd, POLLOUT, end)) return 0;
    ssize_t size = write(fd, text + sent, length - sent);
    if (size < 0 && errno == EINTR) continue;
    if (size < 1) return 0;
    sent += (size_t)size;
  }
  return 1;
}
int guardian_digest(const void *bytes, size_t size, char result[65]) {
  if (size > UINT32_MAX) return 0;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, (CC_LONG)size, digest);
  for (size_t i = 0; i < sizeof(digest); i++) snprintf(result + i * 2, 3, "%02x", digest[i]);
  return 1;
}
static int same_file(struct stat a, struct stat b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
    a.st_uid == b.st_uid && a.st_mode == b.st_mode &&
    a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
    a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
int guardian_asset(const char *path, const char *hash) {
  struct stat before, held, after, named;
  if (strlen(hash) != 64 || lstat(path, &before) || !S_ISREG(before.st_mode) || before.st_uid != getuid() ||
      (before.st_mode & 0777) != 0700 || before.st_size < 1 || before.st_size > 16777216) return 0;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return 0;
  int valid = fstat(fd, &held) == 0 && same_file(before, held);
  CC_SHA256_CTX context; CC_SHA256_Init(&context);
  unsigned char buffer[4096], digest[32]; ssize_t size;
  while (valid && (size = read(fd, buffer, sizeof(buffer))) != 0) {
    if (size < 0) { if (errno == EINTR) continue; valid = 0; break; }
    CC_SHA256_Update(&context, buffer, (CC_LONG)size);
  }
  CC_SHA256_Final(digest, &context);
  char observed[65];
  for (int i = 0; i < 32; i++) snprintf(observed + i * 2, 3, "%02x", digest[i]);
  if (fstat(fd, &after) || lstat(path, &named) || !same_file(before, after) || !same_file(before, named) || strcmp(hash, observed)) valid = 0;
  close(fd); return valid;
}
void guardian_emit(const char *json) {
  size_t size = strlen(json);
  if (size > 4096) _exit(70);
  unsigned char prefix[4] = {(size >> 24) & 255, (size >> 16) & 255, (size >> 8) & 255, size & 255};
  /* One synchronous serialized receipt; guardian watchdog still bounds a stalled reader. */
  if (fwrite(prefix, 1, 4, stdout) != 4 || fwrite(json, 1, size, stdout) != size || fflush(stdout)) _exit(74);
}
