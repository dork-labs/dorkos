### Fixed

- Agents checking their relay inbox now see only messages waiting for them by default, even when they poll through the built-in `relay_inbox` tool instead of the HTTP endpoint. Before, that tool showed everything, so a message the budget gate rejected could sit right next to real ones with nothing telling them apart. Pass `status: "failed"` to see rejected messages, or `status: "all"` to see everything. (DOR-406)
