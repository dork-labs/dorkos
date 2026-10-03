#include "guardian.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Compare R's captured named-file tuple. This is not loaded-image/kernel attestation. */
int guardian_binding(const char *path, const char *expected) {
  struct stat value;
  if (!path || !expected || lstat(path, &value) || S_ISLNK(value.st_mode) ||
      value.st_uid != getuid() || (value.st_mode & 0777) != 0700 ||
      value.st_size < 0 || value.st_mtimespec.tv_sec < 0 || value.st_ctimespec.tv_sec < 0 ||
      value.st_mtimespec.tv_nsec < 0 || value.st_mtimespec.tv_nsec >= 1000000000 ||
      value.st_ctimespec.tv_nsec < 0 || value.st_ctimespec.tv_nsec >= 1000000000) return 0;
  uint64_t modified = (uint64_t)value.st_mtimespec.tv_sec;
  uint64_t changed = (uint64_t)value.st_ctimespec.tv_sec;
  if (modified > (UINT64_MAX - (uint64_t)value.st_mtimespec.tv_nsec) / 1000000000 ||
      changed > (UINT64_MAX - (uint64_t)value.st_ctimespec.tv_nsec) / 1000000000) return 0;
  modified = modified * 1000000000 + (uint64_t)value.st_mtimespec.tv_nsec;
  changed = changed * 1000000000 + (uint64_t)value.st_ctimespec.tv_nsec;
  char observed[256];
  int size = snprintf(observed, sizeof(observed), "%" PRIu64 ":%" PRIu64 ":%" PRIu64 ":%" PRIu64 ":%" PRIu64 ":%" PRIu64 ":%" PRIu64,
    (uint64_t)value.st_dev, (uint64_t)value.st_ino, (uint64_t)value.st_size,
    (uint64_t)value.st_mode, (uint64_t)value.st_uid, modified, changed);
  return size > 0 && (size_t)size < sizeof(observed) && !strcmp(observed, expected);
}
static int custody(struct guardian *g, const char *path, unsigned int index) {
  char image[4096];
  int size = snprintf(image, sizeof(image), "%s/guardian", g->root);
  return size > 0 && (size_t)size < sizeof(image) &&
    guardian_binding(g->root, g->bindings[0]) &&
    guardian_binding(image, g->bindings[1]) && guardian_binding(path, g->bindings[index]);
}
int guardian_bound_asset(struct guardian *g, const char *path, const char *hash) {
  unsigned int index;
  if (!strcmp(path, g->fixture_a) && !strcmp(hash, g->hash_a)) index = 2;
  else if (!strcmp(path, g->fixture_b) && !strcmp(hash, g->hash_b)) index = 3;
  else return 0;
  return custody(g, path, index) && guardian_asset(path, hash) && custody(g, path, index);
}
