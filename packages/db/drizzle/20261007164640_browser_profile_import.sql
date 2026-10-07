ALTER TABLE `browser_profiles` ADD `import_state` text DEFAULT 'none' NOT NULL CONSTRAINT `browser_profiles_import_state` CHECK (`import_state` IN ('none', 'pending', 'failed', 'ready'));
