CREATE TABLE `mesh_namespace_rules` (
	`source_namespace` text NOT NULL,
	`target_namespace` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`source_namespace`, `target_namespace`)
);
