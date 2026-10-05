#ifndef DORK_GUARDIAN_TREE_H
#define DORK_GUARDIAN_TREE_H
#include <stdbool.h>
struct guardian;
struct guardian_tree;
/* Only G's preregistered exact direct parent may supply the single owned child permit. */
int guardian_tree_open(struct guardian *g);
int guardian_tree_parent_death(struct guardian *g);
int guardian_tree_close(struct guardian *g, unsigned long long end);
#endif
