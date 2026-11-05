CREATE TABLE `profile_avatars` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_user_name_nocase_unique` ON `profiles` (`user_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `profiles_user_idx` ON `profiles` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_avatars` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Every existing user gets a first profile, named after them, and keeps their applications on it.
INSERT INTO `profiles` (`user_id`, `name`, `created_at`, `updated_at`)
SELECT `id`, COALESCE(NULLIF(TRIM(`display_name`), ''), `username`), `created_at`, `created_at` FROM `users`;
--> statement-breakpoint
CREATE TABLE `__new_applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`status` text DEFAULT 'Applied' NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`applied_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "applications_status_check" CHECK("status" in ('Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Rejected', 'Offer'))
);
--> statement-breakpoint
INSERT INTO `__new_applications` (`id`, `user_id`, `profile_id`, `job_id`, `status`, `memo`, `applied_at`, `updated_at`)
SELECT a.`id`, a.`user_id`, p.`id`, a.`job_id`, a.`status`, a.`memo`, a.`applied_at`, a.`updated_at`
FROM `applications` a JOIN `profiles` p ON p.`user_id` = a.`user_id`;
--> statement-breakpoint
DROP TABLE `applications`;
--> statement-breakpoint
ALTER TABLE `__new_applications` RENAME TO `applications`;
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_profile_job_unique` ON `applications` (`profile_id`,`job_id`);
--> statement-breakpoint
CREATE INDEX `applications_job_idx` ON `applications` (`job_id`);
--> statement-breakpoint
CREATE INDEX `applications_user_status_idx` ON `applications` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `applications_user_job_idx` ON `applications` (`user_id`,`job_id`);
