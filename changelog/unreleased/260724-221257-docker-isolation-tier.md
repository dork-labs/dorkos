### Added

- Tests that let an agent loose with real file tools can now run inside a Docker container, so the agent can only touch a throwaway folder made for that one test and nothing else on your computer. Nothing from your home folder is ever shared with it. If Docker is not running, the tests still run the old way and say so instead of failing (DOR-449)
