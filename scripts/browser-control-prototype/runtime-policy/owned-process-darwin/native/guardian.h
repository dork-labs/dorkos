#ifndef DORK_RESEARCH_GUARDIAN_H
#define DORK_RESEARCH_GUARDIAN_H
#include "bridge.h"
#include <stddef.h>
#include <stdint.h>
struct guardian_tree;
struct guardian {
  struct research_child *slots[4];
  struct guardian_tree *tree;
  int (*list_children)(pid_t, void *, int);
  void *installed_library;
  unsigned int census_calls, exit_registrations, exit_events;
  char fixture_a[4096], fixture_b[4096], hash_a[65], hash_b[65], run[65], cohort[3];
  char root[4096], bindings[4][256];
  unsigned long long end, fault_end;
  unsigned int acquisitions, signals, deliveries, refusals, terminations, token_queries, generation;
  const char *reason;
  bool failed, control_lost, cleanup_known;
};
unsigned long long guardian_ms(void);
int guardian_read(struct guardian *g, int fd, char *text, size_t size, unsigned long long end);
int guardian_write(struct guardian *g, int fd, const char *text, unsigned long long end);
int guardian_asset(const char *path, const char *hash);
void guardian_emit(const char *json);
int guardian_digest(const void *bytes, size_t size, char result[65]);
int guardian_bound_asset(struct guardian *g, const char *path, const char *hash);
int guardian_binding(const char *path, const char *expected);
int guardian_exercise(struct guardian *g);
void guardian_cleanup(struct guardian *g);
#endif
