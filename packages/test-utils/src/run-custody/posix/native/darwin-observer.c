/*
 * Test-private, read-only Darwin process observation. See the source-built
 * browser custody prototype for its research context. This observer uses only
 * public SDK APIs and never signals, spawns, or claims ownership of a PID.
 */
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

static int inspect(int pid) {
  struct proc_bsdinfo before = {0};
  struct proc_bsdinfo after = {0};
  char image[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before))
    return 2;
  if (proc_pidpath(pid, image, sizeof(image)) <= 0)
    return 2;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after))
    return 2;
  if (before.pbi_pid != (uint32_t)pid || after.pbi_pid != before.pbi_pid ||
      before.pbi_start_tvsec != after.pbi_start_tvsec ||
      before.pbi_start_tvusec != after.pbi_start_tvusec ||
      before.pbi_pgid != after.pbi_pgid || before.pbi_ppid != after.pbi_ppid)
    return 2;
  printf("%u %u %u %llu:%llu\n", after.pbi_pid, after.pbi_ppid, after.pbi_pgid,
         (unsigned long long)after.pbi_start_tvsec, (unsigned long long)after.pbi_start_tvusec);
  size_t size = strnlen(image, sizeof(image));
  if (!size || size == sizeof(image) || fwrite(image, 1, size, stdout) != size)
    return 2;
  return ferror(stdout) ? 2 : 0;
}

/* A full buffer is unknown, never evidence that the anchor is alone. */
static int group_members(int group) {
  if (getpgrp() != group) return 2;
  pid_t members[256] = {0};
  int count = proc_listpids(PROC_PGRP_ONLY, (uint32_t)group, members, sizeof(members));
  if (count <= 0 || count >= (int)sizeof(members) || count % sizeof(pid_t))
    return 2;
  for (unsigned int i = 0; i < (unsigned int)count / sizeof(pid_t); ++i) {
    if (members[i] > 0 && members[i] != getpid() && printf("%d\n", members[i]) < 0)
      return 2;
  }
  return ferror(stdout) ? 2 : 0;
}

int main(int argc, char **argv) {
  if (argc != 3 || !argv[2][0]) return 2;
  char *end = NULL;
  errno = 0;
  long selector = strtol(argv[2], &end, 10);
  if (errno || *end || selector <= 0 || selector > INT_MAX) return 2;
  if (!strcmp(argv[1], "inspect")) return inspect((int)selector);
  if (!strcmp(argv[1], "group-members")) return group_members((int)selector);
  return 2;
}
