#include "guardian.h"
#include "guardian-tree.h"
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static unsigned long long bounded(struct guardian *g, unsigned int milliseconds) {
  unsigned long long end = guardian_ms() + milliseconds;
  return end < g->end ? end : g->end;
}
static int ready_fixture(struct guardian *g, struct research_child *child, unsigned int baseline, unsigned int image) {
  char line[640]; int pid, counter, image_id, consumed = 0; unsigned long long expiry;
  if (!guardian_read(g, research_channel(child), line, sizeof(line), bounded(g, 2000)) ||
      sscanf(line, "READY\t%d\t%llu\t%d\t%d%n", &pid, &expiry, &counter, &image_id, &consumed) != 4 || line[consumed]) return 0;
  return pid == research_pid(child) && expiry == research_expiry(child) && expiry > guardian_ms() &&
    counter == (int)baseline && image_id == (int)image;
}
static struct research_child *acquire(struct guardian *g) {
  if (g->acquisitions >= 4 || g->control_lost || guardian_ms() >= g->end ||
      !guardian_bound_asset(g, g->fixture_a, g->hash_a) || !guardian_bound_asset(g, g->fixture_b, g->hash_b)) return NULL;
  unsigned int slot = g->acquisitions;
  /* Pre-registered zeroed slot is retained before the fallible acquisition. */
  int error = 0;
  g->slots[slot] = research_spawn_exact(g->fixture_a, g->fixture_b, &error);
  if (!g->slots[slot]) return NULL;
  g->acquisitions++;
  if (!ready_fixture(g, g->slots[slot], 0, 1)) return NULL;
  return g->slots[slot];
}
static int token(struct guardian *g, struct research_child *child, bool constructed, audit_token_t *value, struct research_unique_info *info) {
  if (research_unique(research_pid(child), info).status != 1) return 0;
  if (constructed) return research_construct(research_pid(child), info->version, value).status == 1;
  char line[640], hex[65]; int status, raw, count, end = 0;
  unsigned long long deadline = bounded(g, 1000);
  if (!guardian_write(g, research_channel(child), "TOKEN\n", deadline) ||
      !guardian_read(g, research_channel(child), line, sizeof(line), deadline)) return 0;
  g->token_queries++;
  if (sscanf(line, "TOKEN\t%d\t%d\t%d\t%64[a-f0-9]%n", &status, &raw, &count, hex, &end) != 4 ||
      line[end] || status != 1 || raw || count || strlen(hex) != 64) return 0;
  unsigned char *bytes = (unsigned char *)value;
  for (int i = 0; i < 32; i++) { unsigned int byte; if (sscanf(hex + i * 2, "%2x", &byte) != 1) return 0; bytes[i] = byte; }
  return value->val[5] == (unsigned int)research_pid(child) && value->val[7] == (unsigned int)info->version;
}
static int attempt(struct guardian *g, struct research_child *child, audit_token_t value, bool constructed, unsigned int baseline, bool refusal, bool exited) {
  if (g->signals >= 14 || g->control_lost || guardian_ms() >= g->end) return 0;
  char digest[65], challenge[65], suffix[512], arm[640], expected[640], observed[640];
  unsigned char entropy[32]; arc4random_buf(entropy, sizeof(entropy));
  guardian_digest(&value, sizeof(value), digest); guardian_digest(entropy, sizeof(entropy), challenge);
  snprintf(suffix, sizeof(suffix), "%s\t%s\tattempt-%u\t%u\t%d\t%s\t%s", g->run,
    constructed ? "constructed" : "kernel", g->signals + 1, g->generation, research_pid(child), digest, challenge);
  unsigned long long end = bounded(g, 1000);
  if (!exited) {
    snprintf(arm, sizeof(arm), "ARM\t%s\t%u\n", suffix, baseline);
    snprintf(expected, sizeof(expected), "ARMED\t%s\t%u", suffix, baseline);
    if (!guardian_write(g, research_channel(child), arm, end) || !guardian_read(g, research_channel(child), observed, sizeof(observed), end) || strcmp(expected, observed)) return 0;
  }
  g->signals++;
  struct research_result result = research_signal(child, value, SIGUSR1);
  int delivered = 0, refused = 0;
  if (refusal && result.status == 2 && result.raw == ESRCH) {
    refused = 1;
    if (!exited) {
      snprintf(expected, sizeof(expected), "CANCELLED\t%s\t%u", suffix, baseline);
      if (!guardian_write(g, research_channel(child), "CANCEL\n", end) || !guardian_read(g, research_channel(child), observed, sizeof(observed), end) || strcmp(expected, observed)) refused = 0;
    }
  } else if (!refusal && result.status == 1 && result.raw == 0) {
    snprintf(expected, sizeof(expected), "DELIVERED\t%s\t%u", suffix, baseline + 1);
    delivered = guardian_read(g, research_channel(child), observed, sizeof(observed), end) && !strcmp(expected, observed);
  }
  char receipt[1024];
  snprintf(receipt, sizeof(receipt), "{\"type\":\"attempt\",\"cohort\":\"%s\",\"provenance\":\"%s\",\"ordinal\":%u,\"raw\":%d,\"status\":%d,\"error\":%d,\"delivery\":%s,\"refusal\":%s,\"tokenDigest\":\"%s\"}",
    g->cohort, constructed ? "constructed-private" : "kernel-self-query", g->signals, result.raw, result.status, result.error, delivered ? "true" : "false", refused ? "true" : "false", digest);
  guardian_emit(receipt);
  g->deliveries += delivered; g->refusals += refused;
  if (refusal && result.status == 1) { g->failed = true; g->reason = "UNEXPECTED_API_SUCCESS"; }
  return refusal ? refused : delivered;
}
static int exited(struct guardian *g, struct research_child *child) {
  unsigned long long end = bounded(g, 2000);
  while (guardian_ms() < end && !g->control_lost) {
    bool exit_seen = false;
    if (research_exit_state(child, &exit_seen).status != 1) return 0;
    if (exit_seen) return 1;
    usleep(1000);
  }
  return 0;
}
static int cohort(struct guardian *g, bool constructed) {
  struct research_child *child = acquire(g);
  if (!child) return 0;
  g->generation++;
  audit_token_t value; struct research_unique_info before, after;
  if (!token(g, child, constructed, &value, &before) || !attempt(g, child, value, constructed, 0, false, false)) return 0;
  audit_token_t wrong = value;
  if (wrong.val[7] == UINT_MAX) return 0;
  wrong.val[7]++;
  if (!attempt(g, child, wrong, constructed, 1, true, false) || !attempt(g, child, value, constructed, 1, false, false)) return 0;
  if (!guardian_bound_asset(g, g->fixture_b, g->hash_b) || !guardian_write(g, research_channel(child), "EXEC\n", bounded(g, 2000))) return 0;
  if (!ready_fixture(g, child, 2, 2) ||
      research_unique(research_pid(child), &after).status != 1 || before.unique_id != after.unique_id || before.version == after.version) return 0;
  if (!attempt(g, child, value, constructed, 2, true, false) || !token(g, child, constructed, &value, &after) ||
      !attempt(g, child, value, constructed, 2, false, false) ||
      !guardian_write(g, research_channel(child), "EXIT\n", bounded(g, 1000)) || !exited(g, child) ||
      !attempt(g, child, value, constructed, 3, true, true)) return 0;
  int status;
  if (research_reap(child, &status).status != 1) return 0;
  /* Post-reap control exercises only the opaque wrapper fence, never the kernel call. */
  if (research_signal(child, value, SIGUSR1).status != 2) return 0;
  return 1;
}
static int termination(struct guardian *g, bool constructed) {
  struct research_child *child = acquire(g);
  audit_token_t value; struct research_unique_info info;
  if (!child || !token(g, child, constructed, &value, &info) || g->signals >= 14) return 0;
  g->signals++; int chosen = 0, status = 0;
  struct research_result result = research_terminate(child, value, &chosen);
  int observed = result.status == 1 && result.raw == 0 && (chosen == SIGTERM || chosen == SIGKILL) && exited(g, child) && research_reap(child, &status).status == 1;
  char receipt[512];
  snprintf(receipt, sizeof(receipt), "{\"type\":\"termination\",\"cohort\":\"%s\",\"ordinal\":%u,\"raw\":%d,\"status\":%d,\"error\":%d,\"chosenSignal\":%d,\"waitStatus\":%d,\"observed\":%s}", g->cohort, g->signals, result.raw, result.status, result.error, chosen, status, observed ? "true" : "false");
  guardian_emit(receipt); g->terminations += observed; return observed;
}
int guardian_exercise(struct guardian *g) {
  if (!strcmp(g->cohort, "C2") || !strcmp(g->cohort, "C3")) {
    if (!guardian_tree_open(g)) { g->reason = "CONTROLLED_CENSUS_UNVERIFIED"; return 0; }
    if (!strcmp(g->cohort, "C2")) {
      /* A generic fixture is not an independent observer. Do not fabricate O coverage. */
      g->reason = "OBSERVER_COVERAGE_UNAVAILABLE"; return 0;
    }
    if (!guardian_tree_parent_death(g)) { g->reason = "OWNED_PARENT_DEATH_UNVERIFIED"; return 0; }
    return 1;
  }
  if (strcmp(g->cohort, "C1")) { g->reason = "GUARDIAN_LOSS_CENSUS_UNAVAILABLE"; return 0; }
  return cohort(g, false) && cohort(g, true) && termination(g, false) && termination(g, true);
}
void guardian_cleanup(struct guardian *g) {
  g->cleanup_known = true;
  for (unsigned int i = 0; i < g->acquisitions; i++) research_cooperative_close(g->slots[i]);
  unsigned long long end = g->reason ? guardian_ms() + 20000 : g->end;
  bool tree_closed = guardian_tree_close(g, end);
  while (guardian_ms() < end) {
    bool pending = false;
    for (unsigned int i = 0; i < g->acquisitions; i++) {
      if (!g->slots[i]) continue;
      if (research_pid(g->slots[i]) < 0) { research_dispose(g->slots[i]); g->slots[i] = NULL; continue; }
      int status;
      struct research_result result = research_reap(g->slots[i], &status);
      if (result.status == 1) { research_dispose(g->slots[i]); g->slots[i] = NULL; }
      else pending = true;
    }
    if (!pending) { g->cleanup_known = tree_closed; return; }
    usleep(1000);
  }
  for (unsigned int i = 0; i < g->acquisitions; i++) if (g->slots[i]) g->cleanup_known = false;
}
