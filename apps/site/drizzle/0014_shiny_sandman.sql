ALTER TABLE "managed_connector_event_binding" DROP CONSTRAINT "managed_connector_event_binding_tenant_id_connector_tenant_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_connector_event_definition" DROP CONSTRAINT "managed_connector_event_definition_tenant_id_connector_tenant_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_connector_event_inbox" DROP CONSTRAINT "managed_connector_event_inbox_tenant_id_connector_tenant_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_connector_event_subscription" DROP CONSTRAINT "managed_connector_event_subscription_tenant_id_connector_tenant_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_connector_event_binding" ADD CONSTRAINT "managed_connector_event_binding_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_definition" ADD CONSTRAINT "managed_connector_event_definition_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_inbox" ADD CONSTRAINT "managed_connector_event_inbox_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_connector_event_subscription" ADD CONSTRAINT "managed_connector_event_subscription_tenant_id_connector_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."connector_tenant"("id") ON DELETE cascade ON UPDATE no action;