### Fixed

- The desktop app no longer fails to launch with "Server exited with code 1" when a connected messaging service is slow to respond. Before, if a service like Telegram took too long to answer during startup, the whole app gave up and showed an error. Now the app starts right away and connects your messaging services in the background. The app also waits longer for slow first-time startups instead of giving up after 10 seconds.
