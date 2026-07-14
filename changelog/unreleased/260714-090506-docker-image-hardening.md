### Changed

- **BREAKING**: The published Docker image now runs as a regular, unprivileged user instead of root, so a compromised agent or a bug can't touch the rest of the container as easily. Its data directory moved from `/root/.dork` to `/home/node/.dork`.
  - Migration: before starting the new image, fix ownership of your existing data with `docker run --rm -v dorkos-data:/data alpine chown -R 1000:1000 /data` (swap `dorkos-data` for your own volume or host path), then change every `-v ...:/root/.dork` to `-v ...:/home/node/.dork`. See the [Docker guide](https://dorkos.ai/docs/self-hosting/docker#upgrading-from-an-older-image) for the full walkthrough.
- Shrink the published Docker image by dropping the build toolchain it no longer needs at runtime.
- Add tini to the image so DorkOS starts, shuts down, and cleans up child processes properly, no `--init` flag needed.

### Fixed

- Fix the Docker image's health check, which never actually worked: the setup guides told you to add a `curl`-based check, but the image has no `curl`, so it silently failed forever. The image now runs its own built-in check every 30 seconds, so `docker ps` correctly reports the container as healthy or unhealthy.
