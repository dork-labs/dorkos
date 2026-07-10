### Changed

- Product-media captures can now record in parallel: `capture:record --shards N` splits the shots across N isolated app stacks (each with its own ports and data directory) and merges the results into one run, cutting a full re-record's wall-clock time. A single serial run stays the default, and a sharded run publishes the same asset set.
