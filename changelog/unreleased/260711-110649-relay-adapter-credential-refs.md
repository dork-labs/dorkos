### Changed

- Your Telegram and Slack bot tokens are no longer saved as plain text. DorkOS now moves each token into your computer's encrypted store and keeps only a pointer to it in the settings file, so a leaked or shared config file no longer exposes your bots. Bots you already connected keep working: their tokens are moved for you the first time DorkOS starts, with nothing to reconfigure (DOR-280)
