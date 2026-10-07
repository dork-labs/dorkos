ALTER TABLE `browser_profiles` ADD `import_state` text DEFAULT 'none' NOT NULL CHECK (`import_state` IN ('none', 'pending', 'failed', 'ready'));
