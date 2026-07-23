### Added

- DorkOS now guards its own promise that adding one capability lights it up everywhere: a conformance check proves every action an agent can take shows up on both tool servers, in the command line, and in the docs, with nothing missing or left over, and it fails the build the moment they drift apart. A new (still-experimental) test also checks that an agent asked "what can you do in DorkOS?" really looks up the live list instead of guessing (DOR-445)
