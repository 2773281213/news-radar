CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`event_id` text,
	`claim_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`reason` text NOT NULL,
	`sent_channels` text,
	`read_at` text,
	`dedupe_key` text
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_created` ON `alerts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_alerts_dedupe` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `article_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` text NOT NULL,
	`seen_at` text NOT NULL,
	`title` text NOT NULL,
	`content_hash` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `idx_artver_article` ON `article_versions` (`article_id`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`canonical_url` text,
	`normalized_url` text NOT NULL,
	`guid` text,
	`title` text NOT NULL,
	`title_norm` text NOT NULL,
	`author` text,
	`lang` text,
	`published_at` text,
	`src_updated_at` text,
	`first_seen_at` text NOT NULL,
	`last_crawled_at` text,
	`body_text` text,
	`excerpt` text,
	`image_url` text,
	`content_hash` text,
	`simhash` text,
	`is_reprint` integer DEFAULT false NOT NULL,
	`reprint_of` text,
	`wire_family` text,
	`paywalled` integer DEFAULT false NOT NULL,
	`event_id` text,
	`status` text DEFAULT 'new' NOT NULL,
	`extra` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_articles_normurl` ON `articles` (`normalized_url`);--> statement-breakpoint
CREATE INDEX `idx_articles_source` ON `articles` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_articles_event` ON `articles` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_articles_published` ON `articles` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_articles_status` ON `articles` (`status`);--> statement-breakpoint
CREATE INDEX `idx_articles_chash` ON `articles` (`content_hash`);--> statement-breakpoint
CREATE TABLE `briefings` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`period_key` text NOT NULL,
	`created_at` text NOT NULL,
	`cutoff_at` text NOT NULL,
	`tz` text NOT NULL,
	`content` text,
	`content_md` text,
	`prev_id` text,
	`delta` text,
	`engine` text DEFAULT 'extractive' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_briefings_period` ON `briefings` (`type`,`period_key`);--> statement-breakpoint
CREATE INDEX `idx_briefings_created` ON `briefings` (`created_at`);--> statement-breakpoint
CREATE TABLE `claim_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`claim_id` text NOT NULL,
	`article_id` text NOT NULL,
	`stance` text DEFAULT 'reports' NOT NULL,
	`family_key` text,
	`has_primary` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claim_evidence` ON `claim_evidence` (`claim_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `idx_evidence_article` ON `claim_evidence` (`article_id`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`text` text NOT NULL,
	`text_norm` text NOT NULL,
	`type` text DEFAULT 'event' NOT NULL,
	`claimed_by` text,
	`claimed_by_kind` text,
	`party` text,
	`subject_number` real,
	`number_unit` text,
	`as_of` text,
	`occurred_at` text,
	`published_at` text,
	`first_seen_at` text NOT NULL,
	`status` text DEFAULT 'reported' NOT NULL,
	`rationale` text,
	`last_checked_at` text,
	`superseded_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_claims_event` ON `claims` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_claims_status` ON `claims` (`status`);--> statement-breakpoint
CREATE TABLE `event_articles` (
	`event_id` text NOT NULL,
	`article_id` text NOT NULL,
	`added_at` text NOT NULL,
	`role` text DEFAULT 'report' NOT NULL,
	`family_key` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_event_articles` ON `event_articles` (`event_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `idx_evtart_article` ON `event_articles` (`article_id`);--> statement-breakpoint
CREATE TABLE `event_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`summary` text,
	`changes` text
);
--> statement-breakpoint
CREATE INDEX `idx_evtver_event` ON `event_versions` (`event_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`one_liner` text,
	`status` text DEFAULT 'developing' NOT NULL,
	`track_mode` text DEFAULT 'normal' NOT NULL,
	`importance` integer DEFAULT 30 NOT NULL,
	`heat` integer DEFAULT 0 NOT NULL,
	`prev_heat` integer DEFAULT 0 NOT NULL,
	`topics` text,
	`countries` text,
	`entities` text,
	`first_at` text NOT NULL,
	`last_update_at` text NOT NULL,
	`last_verified_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`summary` text,
	`summary_engine` text DEFAULT 'extractive' NOT NULL,
	`dirty` integer DEFAULT true NOT NULL,
	`last_summary_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_events_lastupdate` ON `events` (`last_update_at`);--> statement-breakpoint
CREATE INDEX `idx_events_status` ON `events` (`status`);--> statement-breakpoint
CREATE INDEX `idx_events_importance` ON `events` (`importance`);--> statement-breakpoint
CREATE TABLE `fetch_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ok` integer NOT NULL,
	`http_status` integer,
	`found` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`error` text,
	`ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fetchlog_source` ON `fetch_log` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_fetchlog_started` ON `fetch_log` (`started_at`);--> statement-breakpoint
CREATE TABLE `kv_store` (
	`k` text PRIMARY KEY NOT NULL,
	`v` text NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE TABLE `push_subs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`ua` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_push_endpoint` ON `push_subs` (`endpoint`);--> statement-breakpoint
CREATE TABLE `source_families` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`homepage` text,
	`feed_url` text,
	`adapter` text NOT NULL,
	`config` text,
	`country` text,
	`region` text,
	`lang` text,
	`category` text NOT NULL,
	`owner` text,
	`ownership_note` text,
	`is_party` integer DEFAULT false NOT NULL,
	`party_of` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`paywalled` integer DEFAULT false NOT NULL,
	`fetch_fulltext` integer DEFAULT false NOT NULL,
	`interval_min` integer DEFAULT 30 NOT NULL,
	`verif_status` text DEFAULT 'pending' NOT NULL,
	`verif_basis` text,
	`last_reviewed_at` text,
	`family_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fetch_at` text,
	`last_success_at` text,
	`consec_fails` integer DEFAULT 0 NOT NULL,
	`backoff_until` text,
	`health` text DEFAULT 'unknown' NOT NULL,
	`corrections` integer DEFAULT 0 NOT NULL,
	`added_by` text DEFAULT 'seed' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sources_enabled` ON `sources` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_sources_category` ON `sources` (`category`);--> statement-breakpoint
CREATE TABLE `watchlists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`keywords` text,
	`entities` text,
	`min_importance` integer DEFAULT 40 NOT NULL,
	`channels` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
