CREATE TABLE `workflow_ministry_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`ministry` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`findings` text NOT NULL,
	`risks` text NOT NULL,
	`evidence_gaps` text NOT NULL,
	`actions` text NOT NULL,
	`citations` text NOT NULL,
	`claim_refs` text NOT NULL,
	`rules_version` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`error_code` text,
	`error_detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_ministry_report_attempt` ON `workflow_ministry_reports` (`run_id`,`ministry`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_workflow_ministry_report_run` ON `workflow_ministry_reports` (`run_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_workflow_ministry_report_event` ON `workflow_ministry_reports` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_ministry_report_ministry_status` ON `workflow_ministry_reports` (`ministry`,`status`);