### Added

- Try DorkOS without installing anything: `npx dorkos@latest` downloads it, starts it, and opens the cockpit in your browser. The first run takes a minute or two; a regular install skips that wait next time.
- Starting DorkOS on a server got simpler: download a ready-made Docker Compose file from [dorkos.ai/compose.yml](https://dorkos.ai/compose.yml) and run `docker compose up -d`. The deployment guide now also explains when to pick Docker and when a direct install fits better.
