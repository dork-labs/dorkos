### Added

- Tests that let an agent loose with real file tools can now run inside a Docker container. The container gets one folder: a throwaway one made for that single test. It has no network, so nothing in the test can reach the internet or reach DorkOS on your own machine. If Docker is not running, the tests still run the old way and say so instead of failing (DOR-449)
