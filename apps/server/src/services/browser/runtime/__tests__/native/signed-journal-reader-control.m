// Compile-only-on-request native control: linked original reader, actual openat/no-follow/read calls.
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
static int mutate = 0, outsideReads = 0;
static dev_t outsideDevice;
static ino_t outsideInode;
static const char *outsidePath;
static int originalStatAt(int fd, const char *name, struct stat *s, int flags) { return fstatat(fd, name, s, flags); }
static ssize_t originalRead(int fd, void *bytes, size_t size) { return read(fd, bytes, size); }
static int controlledStatAt(int fd, const char *name, struct stat *s, int flags) {
  int result = originalStatAt(fd, name, s, flags);
  if (!result && mutate && !strcmp(name, "journal-owned")) {
    mutate = 0;
    if (renameat(fd, name, fd, "retained-original") || symlinkat(outsidePath, fd, name)) return -1;
  }
  return result;
}
static ssize_t controlledRead(int fd, void *bytes, size_t size) {
  struct stat original = {0};
  if (!fstat(fd, &original) && original.st_dev == outsideDevice && original.st_ino == outsideInode) outsideReads++;
  return originalRead(fd, bytes, size);
}
#define fstatat controlledStatAt
#define read controlledRead
#define main reader_main
#include "signed-journal-reader.m"
#undef main
#undef read
#undef fstatat
static int put(int parent, const char *name, const char *data) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return 0;
  int okay = write(fd, data, strlen(data)) == (ssize_t)strlen(data);
  if (close(fd)) okay = 0;
  return okay;
}
// dup shares its original open-file description, including the directory cursor.
// Each independent control needs a fresh description before the linked walk consumes it.
static BOOL controlWalk(int root, NSMutableArray *rows, NSUInteger *visited, NSUInteger *retained) {
  int scan = openat(root, ".", directoryFlags);
  if (scan < 0) return NO;
  BOOL okay = walk(scan, @".dork/browser/journals", 0, NO, rows, visited, retained);
  if (close(scan) != 0) okay = NO;
  return okay;
}
static int exercise(int root, int excluded, int journal, const char *outside) {
  if (!put(journal, "snapshot.json", "{\"original\":true}") || !put(excluded, "snapshot.json", "{\"excluded\":true}")) return 3;
  struct stat sentinel = {0};
  if (originalStatAt(excluded, "snapshot.json", &sentinel, AT_SYMLINK_NOFOLLOW)) return 4;
  outsideDevice = sentinel.st_dev; outsideInode = sentinel.st_ino; outsidePath = outside;
  NSMutableArray *rows = [NSMutableArray array];
  NSUInteger visited = 0, retained = 0;
  if (!controlWalk(root, rows, &visited, &retained) || rows.count != 1 || outsideReads) return 5;
  rows = [NSMutableArray array]; visited = retained = 0; mutate = 1;
  if (controlWalk(root, rows, &visited, &retained) || rows.count || outsideReads || mutate) return 6;
  if (unlinkat(root, "journal-owned", 0) || renameat(root, "retained-original", root, "journal-owned") ||
      unlinkat(journal, "snapshot.json", 0) || symlinkat([[NSString stringWithUTF8String:outside] stringByAppendingPathComponent:@"snapshot.json"].fileSystemRepresentation, journal, "snapshot.json")) return 7;
  rows = [NSMutableArray array]; visited = retained = 0;
  if (controlWalk(root, rows, &visited, &retained) || rows.count || outsideReads) return 8;
  return 0;
}
int main(void) {
  @autoreleasepool {
    char owned[] = "/tmp/dork-signed-reader-owned-XXXXXX", outside[] = "/tmp/dork-signed-reader-excluded-XXXXXX";
    BOOL ownedMade = mkdtemp(owned) != NULL, outsideMade = mkdtemp(outside) != NULL;
    int root = ownedMade ? open(owned, directoryFlags) : -1;
    int excluded = outsideMade ? open(outside, directoryFlags) : -1;
    int journal = -1, first = 0;
    if (root < 0 || excluded < 0 || mkdirat(root, "journal-owned", 0700)) first = 1;
    if (!first) { journal = openat(root, "journal-owned", directoryFlags); if (journal < 0) first = 2; }
    if (!first) first = exercise(root, excluded, journal, outside);
    // Every original descriptor and fixed owned path is cleaned independently, including assertion failure.
    if (journal >= 0) {
      if (unlinkat(journal, "snapshot.json", 0) && errno != ENOENT && !first) first = 9;
      if (close(journal) && !first) first = 9;
    }
    if (root >= 0) {
      const char *names[] = {"journal-owned", "retained-original"};
      for (int index = 0; index < 2; index++) {
        const char *name = names[index];
        struct stat fact = {0};
        if (!originalStatAt(root, name, &fact, AT_SYMLINK_NOFOLLOW)) {
          if (unlinkat(root, name, S_ISDIR(fact.st_mode) ? AT_REMOVEDIR : 0) && !first) first = 9;
        } else if (errno != ENOENT && !first) first = 9;
      }
      if (close(root) && !first) first = 9;
    }
    if (excluded >= 0) {
      if (unlinkat(excluded, "snapshot.json", 0) && errno != ENOENT && !first) first = 9;
      if (close(excluded) && !first) first = 9;
    }
    if (ownedMade && rmdir(owned) && !first) first = 9;
    if (outsideMade && rmdir(outside) && !first) first = 9;
    if (!first) puts("ORIGINAL_SIGNED_JOURNAL_READER_CONTROLS_PASS");
    return first;
  }
}
