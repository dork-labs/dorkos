#ifndef DORK_RESEARCH_BRIDGE_H
#define DORK_RESEARCH_BRIDGE_H
#include <mach/mach.h>
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>

/* Research-only private ABI correspondence: Apple XNU f6217f8,
 * bsd/sys/proc_info_private.h (APSL 2.0, https://www.apple.com/apsl/).
 * Absent from installed public SDK; this declaration is not a supported API. */
struct research_unique_info {
  uint8_t uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t version;
  int32_t original_parent_version;
  uint64_t reserved2;
  uint64_t reserved3;
};
_Static_assert(sizeof(struct research_unique_info) == 56, "Pinned private ABI size");

struct research_result { int status; int raw; int error; };
struct research_child; /* Sole-parent opaque ownership, never imported from a PID. */

struct research_result research_self_token(audit_token_t *token);
struct research_result research_unique(pid_t pid, struct research_unique_info *info);
struct research_result research_construct(pid_t pid, int32_t version, audit_token_t *token);
struct research_child *research_spawn(const char *fixture, char *const argv[], int *error);
int research_channel(struct research_child *child);
void research_cooperative_close(struct research_child *child);
struct research_result research_signal(struct research_child *child, audit_token_t token, int signal);
struct research_result research_reap(struct research_child *child, int *status);
void research_dispose(struct research_child *child);
struct research_child *research_spawn_exact(const char *fixture_a, const char *fixture_b, int *error);
struct research_child *research_spawn_parent(const char *fixture_a, const char *fixture_b, int *error);
pid_t research_pid(struct research_child *child);
struct research_result research_exit_state(struct research_child *child, bool *exited);
struct research_result research_terminate(struct research_child *child, audit_token_t token, int *chosen_signal);
unsigned int research_identity_queries(void);
unsigned long long research_expiry(struct research_child *child);
#endif
