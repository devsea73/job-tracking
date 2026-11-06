CREATE TABLE `duplicate_candidates` (
	`job_id_low` integer NOT NULL,
	`job_id_high` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`job_id_low`, `job_id_high`),
	FOREIGN KEY (`job_id_low`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id_high`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `duplicate_candidates_status_idx` ON `duplicate_candidates` (`status`,`score`);--> statement-breakpoint
CREATE INDEX `duplicate_candidates_high_idx` ON `duplicate_candidates` (`job_id_high`);--> statement-breakpoint
CREATE TABLE `job_facts` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`work_arrangement` text,
	`employment_type` text,
	`clearance` text,
	`is_federal` integer DEFAULT false NOT NULL,
	`posted_at` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`salary_period` text,
	`checked_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_facts_checked_idx` ON `job_facts` (`checked_at`);--> statement-breakpoint
CREATE TABLE `job_signatures` (
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`job_id` integer NOT NULL,
	PRIMARY KEY(`kind`, `value`, `job_id`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_signatures_job_idx` ON `job_signatures` (`job_id`);