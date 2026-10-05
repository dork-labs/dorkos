#ifndef DORKOS_DARWIN_PROCESS_OBSERVER_H
#define DORKOS_DARWIN_PROCESS_OBSERVER_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define DORKOS_DARWIN_REQUEST_MAX 512
#define DORKOS_DARWIN_ENUMERATION_MAX 16384

enum dorkos_darwin_kind { DORKOS_DARWIN_PRESENT, DORKOS_DARWIN_ABSENT, DORKOS_DARWIN_UNKNOWN };
struct dorkos_darwin_process {
  pid_t pid;
  enum dorkos_darwin_kind kind;
  uint64_t seconds, microseconds;
  pid_t parent_pid;
  int zombie, error;
};
struct dorkos_darwin_batch {
  uint64_t boot_seconds, boot_microseconds;
  size_t count;
  struct dorkos_darwin_process processes[DORKOS_DARWIN_REQUEST_MAX];
};
struct dorkos_darwin_children {
  struct dorkos_darwin_batch batch;
  struct dorkos_darwin_process parent_before, parent_after;
  int have_parent_before, have_parent_after, complete;
};

/* Read-only sampled evidence, not an atomic process tree or a signal authority.
 * Absent requires missing from two complete zombie-inclusive enumerations.
 * Query errors, short reads, PID birth changes and enumeration gaps are unknown.
 * Returns an errno value on batch-wide failure; no partial batch is admitted. */
int dorkos_darwin_inspect(const pid_t *pids, size_t count, struct dorkos_darwin_batch *batch);
int dorkos_darwin_children(pid_t parent, struct dorkos_darwin_children *result);

#endif
