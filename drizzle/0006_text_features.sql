CREATE TABLE `job_text_features` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`hash` text,
	`length` integer DEFAULT 0 NOT NULL,
	`shingles` blob NOT NULL,
	`words` blob NOT NULL,
	`requisitions` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_text_features_hash_idx` ON `job_text_features` (`hash`);
