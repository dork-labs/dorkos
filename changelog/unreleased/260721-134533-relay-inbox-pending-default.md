### Changed

- Reading an agent's Relay inbox now shows only its real, deliverable messages by default. Before, a message the budget gate rejected could show up right next to real ones, with nothing telling a script apart. Pass `?status=failed` to see rejected messages, or `?status=all` to see everything. (DOR-337)
