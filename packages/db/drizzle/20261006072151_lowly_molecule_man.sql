DROP INDEX `canvas_doc_batches_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_batches_active_unique` ON `canvas_doc_batches` (`document_id`,`route_id`) WHERE "status" in ('accepted', 'dispatching', 'turn_started', 'in_doubt')
        AND (delivery_kind IS NOT 'room_app_event' OR status IS NOT 'accepted');