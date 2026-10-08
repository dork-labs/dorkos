// Fixture-only descriptor-relative journal reader. No AppKit, OS preferences or UI permissions.
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static const int directoryFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
static BOOL same(struct stat a, struct stat b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
    a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
    a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
static int rooted(NSString *home) {
  if (!home.isAbsolutePath || home.length > 4096 || ![home isEqual:home.stringByStandardizingPath]) return -1;
  int fd = open("/", directoryFlags);
  NSUInteger depth = 0;
  for (NSString *part in home.pathComponents) {
    if ([part isEqual:@"/"]) continue;
    if (++depth > 64 || !part.length || [part isEqual:@"."] || [part isEqual:@".."]) { if (fd >= 0) close(fd); return -1; }
    int next = fd < 0 ? -1 : openat(fd, part.fileSystemRepresentation, directoryFlags);
    if (fd >= 0 && close(fd) != 0) { if (next >= 0) close(next); return -1; }
    fd = next;
    if (fd < 0) return -1;
  }
  return fd;
}
static BOOL walk(int fd, NSString *relative, NSUInteger depth, BOOL journal, NSMutableArray *rows, NSUInteger *visited, NSUInteger *retained) {
  if (depth > 8) return NO;
  int copied = dup(fd);
  DIR *entries = copied < 0 ? NULL : fdopendir(copied);
  if (!entries) { if (copied >= 0) close(copied); return NO; }
  BOOL okay = YES;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(entries);
    if (!entry) { if (errno) okay = NO; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++*visited > 512) { okay = NO; break; }
    NSString *name = [NSString stringWithUTF8String:entry->d_name];
    struct stat fact = {0};
    if (!name || fstatat(fd, entry->d_name, &fact, AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(fact.st_mode)) { okay = NO; break; }
    NSString *path = [relative stringByAppendingPathComponent:name];
    if (S_ISDIR(fact.st_mode)) {
      int child = openat(fd, entry->d_name, directoryFlags);
      struct stat actual = {0};
      if (child < 0 || fstat(child, &actual) != 0 || fact.st_dev != actual.st_dev || fact.st_ino != actual.st_ino || !S_ISDIR(actual.st_mode)) okay = NO;
      if (okay) okay = walk(child, path, depth + 1, [name hasPrefix:@"journal-"], rows, visited, retained);
      if (child >= 0 && close(child) != 0) okay = NO;
    } else if (journal && [name isEqual:@"snapshot.json"]) {
      int original = openat(fd, entry->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
      struct stat before = {0}, after = {0};
      unsigned char *bytes = NULL;
      if (original < 0 || fstat(original, &before) != 0 || !S_ISREG(before.st_mode) ||
          fact.st_dev != before.st_dev || fact.st_ino != before.st_ino || before.st_size < 1 || before.st_size > 1024 * 1024 || rows.count >= 128) okay = NO;
      size_t count = 0, capacity = okay ? (size_t)before.st_size + 1 : 0;
      if (okay) { bytes = malloc(capacity); if (!bytes) okay = NO; }
      while (okay && count < capacity) {
        ssize_t n = read(original, bytes + count, capacity - count);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) okay = NO;
        if (n <= 0) break;
        count += (size_t)n;
      }
      if (okay && (fstat(original, &after) != 0 || !same(before, after) || count != (size_t)before.st_size || *retained + count > 1024 * 1024)) okay = NO;
      if (original >= 0 && close(original) != 0) okay = NO;
      if (okay) {
        NSData *data = [NSData dataWithBytes:bytes length:count];
        [rows addObject:@{ @"path": path, @"base64": [data base64EncodedStringWithOptions:0] }];
        *retained += count;
      }
      free(bytes);
    }
    if (!okay) break;
  }
  if (closedir(entries) != 0) okay = NO;
  return okay;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 5 || strcmp(argv[1], "--read-owned-journals")) return 2;
    NSString *home = [NSString stringWithUTF8String:argv[2]];
    NSString *device = [NSString stringWithUTF8String:argv[3]], *inode = [NSString stringWithUTF8String:argv[4]];
    int root = home ? rooted(home) : -1;
    struct stat original = {0};
    BOOL okay = root >= 0 && fstat(root, &original) == 0 && S_ISDIR(original.st_mode) && original.st_uid == getuid() && !(original.st_mode & 077) &&
      [device isEqual:[NSString stringWithFormat:@"%llu", (unsigned long long)original.st_dev]] &&
      [inode isEqual:[NSString stringWithFormat:@"%llu", (unsigned long long)original.st_ino]];
    int folder = -1;
    if (okay) {
      folder = dup(root);
      for (NSString *name in @[@".dork", @"browser", @"journals"]) {
        int next = folder < 0 ? -1 : openat(folder, name.fileSystemRepresentation, directoryFlags);
        if (folder >= 0 && close(folder) != 0) okay = NO;
        folder = next;
        if (folder < 0) { okay = NO; break; }
      }
    }
    NSMutableArray *rows = [NSMutableArray array];
    NSUInteger visited = 0, retained = 0;
    if (okay) okay = walk(folder, @".dork/browser/journals", 0, NO, rows, &visited, &retained);
    if (folder >= 0 && close(folder) != 0) okay = NO;
    if (root >= 0 && close(root) != 0) okay = NO;
    if (!okay) return 3;
    NSData *output = [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
    // The existing original-tool one-MiB aggregate output bank remains authoritative.
    if (!output || output.length + 1 > 1024 * 1024) return 4;
    if (fwrite(output.bytes, 1, output.length, stdout) != output.length || fputc('\n', stdout) == EOF || fflush(stdout) != 0) return 5;
    return 0;
  }
}
