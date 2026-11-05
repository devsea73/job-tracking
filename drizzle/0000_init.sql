CREATE TABLE `application_status_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`old_status` text,
	`new_status` text NOT NULL,
	`changed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `status_history_application_idx` ON `application_status_history` (`application_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`status` text DEFAULT 'Applied' NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`applied_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "applications_status_check" CHECK("applications"."status" in ('Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Rejected', 'Offer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_user_job_unique` ON `applications` (`user_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `applications_job_idx` ON `applications` (`job_id`);--> statement-breakpoint
CREATE INDEX `applications_user_status_idx` ON `applications` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `interviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`stage` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`timezone` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interviews_application_idx` ON `interviews` (`application_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `interviews_scheduled_idx` ON `interviews` (`scheduled_at`);--> statement-breakpoint
CREATE TABLE `job_identifiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`is_discovered` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_identifiers_unique` ON `job_identifiers` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `job_identifiers_job_idx` ON `job_identifiers` (`job_id`);--> statement-breakpoint
CREATE TABLE `job_urls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`original_url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`source_platform` text,
	`external_job_id` text,
	`kind` text DEFAULT 'original' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_urls_normalized_unique` ON `job_urls` (`normalized_url`);--> statement-breakpoint
CREATE INDEX `job_urls_job_idx` ON `job_urls` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_name` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`location` text,
	`description_hash` text,
	`canonical_url` text,
	`is_highlighted` integer DEFAULT false NOT NULL,
	`highlighted_by` integer,
	`highlighted_at` text,
	`company_key` text NOT NULL,
	`title_key` text NOT NULL,
	`extraction_method` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_extracted_at` text,
	FOREIGN KEY (`highlighted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_company_key_idx` ON `jobs` (`company_key`);--> statement-breakpoint
CREATE INDEX `jobs_title_key_idx` ON `jobs` (`title_key`);--> statement-breakpoint
CREATE INDEX `jobs_description_hash_idx` ON `jobs` (`description_hash`);--> statement-breakpoint
CREATE INDEX `jobs_created_at_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_updated_at_idx` ON `jobs` (`updated_at`);--> statement-breakpoint
CREATE INDEX `jobs_company_name_idx` ON `jobs` ("company_name" collate nocase);--> statement-breakpoint
CREATE INDEX `jobs_highlighted_idx` ON `jobs` (`is_highlighted`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('admin', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_nocase_unique` ON `users` (lower("username"));