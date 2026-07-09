### Changed

- Product-capture record phase can now shard across parallel stacks: `capture:record --shards N` splits the shots over `N` isolated servers, each with its own data directory and ports, and merges them into one run, cutting a full re-record's wall-clock time. Serial (`--shards 1`) stays the default and is unchanged; a sharded run produces the same published asset set.
