#include "bridge.h"
#include <errno.h>
#include <libproc.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <unistd.h>
#include <stdio.h>
#include <time.h>

static unsigned int identity_queries;
unsigned int research_identity_queries(void) { return identity_queries; }
enum { RESEARCH_UNKNOWN = 0, RESEARCH_OBSERVED = 1, RESEARCH_REFUSED = 2 };
struct research_child { pid_t pid; pid_t parent; uint64_t unique; bool reaped; int channel; unsigned long long expiry; };
static struct research_result result(int state, int raw, int error) {
  return (struct research_result){state, raw, error};
}

struct research_result research_self_token(audit_token_t *token) {
  if (!token) return result(RESEARCH_REFUSED, 0, EINVAL);
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  memset(token, 0, sizeof(*token));
  kern_return_t raw = task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)token, &count);
  if (raw != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT)
    return result(RESEARCH_UNKNOWN, raw, count);
  return result(RESEARCH_OBSERVED, raw, 0);
}

struct research_result research_unique(pid_t pid, struct research_unique_info *info) {
  if (pid < 1 || !info) return result(RESEARCH_REFUSED, 0, EINVAL);
  memset(info, 0, sizeof(*info)); errno = 0;
  identity_queries++;
  int raw = proc_pidinfo(pid, 17, 1, info, sizeof(*info));
  int saved = errno;
  if (raw != sizeof(*info) || info->unique_id == 0)
    return result(RESEARCH_UNKNOWN, raw, saved);
  return result(RESEARCH_OBSERVED, raw, saved);
}

struct research_result research_construct(pid_t pid, int32_t version, audit_token_t *token) {
  if (pid < 1 || !token) return result(RESEARCH_REFUSED, 0, EINVAL);
  /* Constructed-private selector, not a kernel-issued token or granted authority. */
  memset(token, 0, sizeof(*token)); token->val[5] = (unsigned int)pid;
  token->val[7] = (unsigned int)version;
  return result(RESEARCH_OBSERVED, 0, 0);
}

static int private_channel(int channels[2]) {
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, channels)) return errno;
  for (int i = 0; i < 2; i++) {
    if (channels[i] < 3) {
      int replacement = fcntl(channels[i], F_DUPFD_CLOEXEC, 3);
      if (replacement < 0) {
        int error = errno; close(channels[0]); close(channels[1]); return error;
      }
      close(channels[i]); channels[i] = replacement;
    }
  }
  int yes = 1;
  if (fcntl(channels[0], F_SETFD, FD_CLOEXEC) || fcntl(channels[1], F_SETFD, FD_CLOEXEC) ||
      setsockopt(channels[0], SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes))) {
    int error = errno; close(channels[0]); close(channels[1]); return error;
  }
  return 0;
}

static struct research_child *spawn_owned(const char *fixture, const char *image_b, char *const argv[], int *error) {
  if (!fixture || !argv || !error || !argv[0] || strcmp(argv[0], fixture) ||
      !argv[1] || (strcmp(argv[1], "--fixture") && strcmp(argv[1], "--parent")) || argv[2]) return NULL;
  /* Caller must pre-register this spawn slot and use the hashed owned fixture only.
   * No other reaper/auto-reap is allowed in the serialized research guardian. */
  struct research_child *child = calloc(1, sizeof(*child));
  if (!child) { *error = ENOMEM; return NULL; }
  child->parent = getpid();
  int channels[2]; *error = private_channel(channels);
  if (*error) { free(child); return NULL; }
  posix_spawn_file_actions_t actions;
  *error = posix_spawn_file_actions_init(&actions);
  if (*error) { close(channels[0]); close(channels[1]); free(child); return NULL; }
  *error = posix_spawn_file_actions_adddup2(&actions, channels[1], STDIN_FILENO);
  if (!*error) *error = posix_spawn_file_actions_adddup2(&actions, channels[1], STDOUT_FILENO);
  if (!*error) *error = posix_spawn_file_actions_addclose(&actions, channels[0]);
  if (!*error) *error = posix_spawn_file_actions_addclose(&actions, channels[1]);
  if (!*error) *error = posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
  struct timespec acquired = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &acquired)) *error = errno;
  char expiry[96], image[4096];
  child->expiry = (unsigned long long)acquired.tv_sec * 1000 + acquired.tv_nsec / 1000000 + 15000;
  snprintf(expiry, sizeof(expiry), "DORK_RESEARCH_EXPIRY=%llu", child->expiry);
  int image_size = snprintf(image, sizeof(image), "DORK_RESEARCH_IMAGE_B=%s", image_b ? image_b : fixture);
  if (image_size < 0 || (size_t)image_size >= sizeof(image)) *error = EINVAL;
  char *environment[] = {"PATH=/usr/bin:/bin", expiry, image, "DORK_RESEARCH_COUNTER=0", NULL};
  posix_spawnattr_t attributes;
  int attribute_error = posix_spawnattr_init(&attributes);
  if (!*error) *error = attribute_error;
  if (!*error) *error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  if (!*error) *error = posix_spawn(&child->pid, fixture, &actions, &attributes, argv, environment);
  if (!attribute_error) posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions); close(channels[1]);
  if (*error) { close(channels[0]); free(child); return NULL; }
  child->channel = channels[0];
  /* Retain even failed identity acquisition so cooperative cleanup remains possible. */
  struct research_unique_info info;
  if (research_unique(child->pid, &info).status == RESEARCH_OBSERVED) child->unique = info.unique_id;
  return child;
}

int research_channel(struct research_child *child) {
  return child && !child->reaped && child->parent == getpid() ? child->channel : -1;
}

void research_cooperative_close(struct research_child *child) {
  if (child && child->parent == getpid() && child->channel >= 0) {
    close(child->channel); child->channel = -1; /* Fixture lifeline EOF, never private signaling. */
  }
}

struct research_result research_signal(struct research_child *child, audit_token_t token, int sig) {
  if (!child || child->reaped || child->parent != getpid() || !child->unique ||
      token.val[5] != (unsigned int)child->pid || sig != SIGUSR1)
    return result(RESEARCH_REFUSED, 0, EINVAL);
  siginfo_t state; memset(&state, 0, sizeof(state)); errno = 0;
  if (waitid(P_PID, child->pid, &state, WEXITED | WNOHANG | WNOWAIT) != 0)
    return result(RESEARCH_UNKNOWN, -1, errno);
  struct research_unique_info current;
  struct research_result observed = research_unique(child->pid, &current);
  if (observed.status != RESEARCH_OBSERVED) return observed;
  if (current.unique_id != child->unique) return result(RESEARCH_REFUSED, 0, ESRCH);
  /* Version deliberately not normalized: stale exec-version refusal is an experiment. */
  int raw = proc_signal_with_audittoken(&token, sig);
  int state_result = raw == 0 ? RESEARCH_OBSERVED :
    (raw == ESRCH ? RESEARCH_REFUSED : RESEARCH_UNKNOWN);
  return result(state_result, raw, raw);
}

struct research_result research_reap(struct research_child *child, int *status) {
  if (!child || !status || child->reaped || child->parent != getpid())
    return result(RESEARCH_REFUSED, 0, EINVAL);
  int raw = waitpid(child->pid, status, WNOHANG);
  if (raw == child->pid) { child->reaped = true; return result(RESEARCH_OBSERVED, raw, 0); }
  return result(RESEARCH_UNKNOWN, raw, raw < 0 ? errno : 0);
}

void research_dispose(struct research_child *child) {
  /* Cannot drop custody of a live or unreaped child. */
  if (child && child->reaped) { research_cooperative_close(child); free(child); }
}

struct research_child *research_spawn(const char *fixture, char *const argv[], int *error) {
  return spawn_owned(fixture, fixture, argv, error);
}
struct research_child *research_spawn_exact(const char *fixture_a, const char *fixture_b, int *error) {
  char *arguments[] = {(char *)fixture_a, "--fixture", NULL};
  return spawn_owned(fixture_a, fixture_b, arguments, error);
}
pid_t research_pid(struct research_child *child) {
  return child && !child->reaped && child->parent == getpid() ? child->pid : -1;
}
struct research_result research_exit_state(struct research_child *child, bool *exited) {
  if (!child || !exited || child->reaped || child->parent != getpid()) return result(RESEARCH_REFUSED, 0, EINVAL);
  siginfo_t state; memset(&state, 0, sizeof(state));
  errno = 0;
  int raw = waitid(P_PID, child->pid, &state, WEXITED | WNOHANG | WNOWAIT);
  if (raw) return result(RESEARCH_UNKNOWN, raw, errno);
  *exited = state.si_pid == child->pid;
  return result(RESEARCH_OBSERVED, raw, 0);
}
struct research_result research_terminate(struct research_child *child, audit_token_t token, int *chosen_signal) {
  if (!child || !chosen_signal || child->reaped || child->parent != getpid() || !child->unique ||
      token.val[5] != (unsigned int)child->pid) return result(RESEARCH_REFUSED, 0, EINVAL);
  bool exited;
  struct research_result observed = research_exit_state(child, &exited);
  if (observed.status != RESEARCH_OBSERVED || exited) return result(RESEARCH_REFUSED, 0, ESRCH);
  struct research_unique_info current;
  observed = research_unique(child->pid, &current);
  if (observed.status != RESEARCH_OBSERVED) return observed;
  if (current.unique_id != child->unique) return result(RESEARCH_REFUSED, 0, ESRCH);
  int raw = proc_terminate_with_audittoken(&token, chosen_signal);
  return result(raw == 0 ? RESEARCH_OBSERVED : (raw == ESRCH ? RESEARCH_REFUSED : RESEARCH_UNKNOWN), raw, raw);
}

unsigned long long research_expiry(struct research_child *child) {
  return child && child->parent == getpid() ? child->expiry : 0;
}

struct research_child *research_spawn_parent(const char *fixture_a, const char *fixture_b, int *error) {
  char *arguments[] = {(char *)fixture_a, "--parent", NULL};
  return spawn_owned(fixture_a, fixture_b, arguments, error);
}
