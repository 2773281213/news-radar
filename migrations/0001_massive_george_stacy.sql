CREATE TABLE `workflow_cases` (
	`event_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_department` text DEFAULT 'zhongshu' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`rules_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`active_run_id` text,
	`proposal` text,
	`review` text,
	`dispatch` text,
	`publishable` integer DEFAULT false NOT NULL,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`approved_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_cases_status` ON `workflow_cases` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workflow_cases_department` ON `workflow_cases` (`current_department`);--> statement-breakpoint
CREATE INDEX `idx_workflow_cases_publishable` ON `workflow_cases` (`publishable`);--> statement-breakpoint
CREATE INDEX `idx_workflow_cases_updated` ON `workflow_cases` (`updated_at`);--> statement-breakpoint
CREATE TABLE `workflow_ministry_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`ministry` text NOT NULL,
	`score` integer NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`reasons` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_assignment` ON `workflow_ministry_assignments` (`run_id`,`ministry`);--> statement-breakpoint
CREATE INDEX `idx_workflow_assignment_event` ON `workflow_ministry_assignments` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_assignment_ministry` ON `workflow_ministry_assignments` (`ministry`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`rules_version` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`lease_until` text,
	`next_attempt_at` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error_code` text,
	`error_detail` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_run_input` ON `workflow_runs` (`event_id`,`input_hash`,`rules_version`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_event` ON `workflow_runs` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_status` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_retry` ON `workflow_runs` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `workflow_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`department` text NOT NULL,
	`action` text NOT NULL,
	`reason_code` text NOT NULL,
	`rationale` text,
	`artifact` text,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_transition_sequence` ON `workflow_transitions` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_transition_key` ON `workflow_transitions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_workflow_transition_event` ON `workflow_transitions` (`event_id`);--> statement-breakpoint
DELETE FROM `alerts`
WHERE `dedupe_key` IS NOT NULL
  AND `id` NOT IN (
    SELECT MIN(`id`) FROM `alerts` WHERE `dedupe_key` IS NOT NULL GROUP BY `dedupe_key`
  );--> statement-breakpoint
DROP INDEX `idx_alerts_dedupe`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_alerts_dedupe` ON `alerts` (`dedupe_key`);