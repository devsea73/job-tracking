-- Applications keep a stage worked out from their timeline instead of a status set by hand: the
-- latest step's, or Applied without one. Triggers keep it, and the furthest stage reached, up to date.
-- Applications also get a created_at of their own: when the record was written, which is bookkeeping;
-- applied_at stays the day the person applied, and is what bids are counted by.
CREATE TABLE `__new_applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`stage` text DEFAULT 'Applied' NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`furthest_rank` integer DEFAULT 0 NOT NULL,
	`job_url_id` integer,
	`applied_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_url_id`) REFERENCES `job_urls`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "applications_stage_check" CHECK("stage" in ('Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer', 'Rejected'))
);
--> statement-breakpoint
-- The record was written together with its first status change; without one, the applied date is the best known.
INSERT INTO `__new_applications` (`id`, `user_id`, `profile_id`, `job_id`, `stage`, `memo`, `furthest_rank`, `job_url_id`, `applied_at`, `created_at`, `updated_at`)
SELECT a.`id`, a.`user_id`, a.`profile_id`, a.`job_id`,
  COALESCE((SELECT s.`stage` FROM `application_steps` s WHERE s.`application_id` = a.`id` ORDER BY s.`at` DESC, s.`id` DESC LIMIT 1), 'Applied'),
  a.`memo`,
  COALESCE((SELECT MAX(CASE s.`stage` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END) FROM `application_steps` s WHERE s.`application_id` = a.`id`), 0),
  a.`job_url_id`, a.`applied_at`,
  COALESCE((SELECT MIN(h.`changed_at`) FROM `application_status_history` h WHERE h.`application_id` = a.`id`), a.`applied_at`),
  a.`updated_at`
FROM `applications` a;
--> statement-breakpoint
DROP TABLE `application_status_history`;
--> statement-breakpoint
DROP TABLE `interviews`;
--> statement-breakpoint
DROP TABLE `applications`;
--> statement-breakpoint
ALTER TABLE `__new_applications` RENAME TO `applications`;
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_profile_job_unique` ON `applications` (`profile_id`,`job_id`);
--> statement-breakpoint
CREATE INDEX `applications_job_idx` ON `applications` (`job_id`);
--> statement-breakpoint
CREATE INDEX `applications_user_job_idx` ON `applications` (`user_id`,`job_id`);
--> statement-breakpoint
CREATE INDEX `applications_stage_idx` ON `applications` (`stage`);
--> statement-breakpoint
CREATE INDEX `applications_user_stage_idx` ON `applications` (`user_id`,`stage`);
--> statement-breakpoint
CREATE INDEX `applications_job_url_idx` ON `applications` (`job_url_id`);
--> statement-breakpoint
CREATE INDEX `applications_applied_idx` ON `applications` (`applied_at`);
--> statement-breakpoint
CREATE INDEX `applications_furthest_idx` ON `applications` (`furthest_rank`,`profile_id`);
--> statement-breakpoint
-- Dropping the old table took its triggers with it: the job's counters and the memo search.
CREATE TRIGGER `applications_count_after_insert` AFTER INSERT ON `applications` BEGIN
  UPDATE `jobs` SET `application_count` = `application_count` + 1, `last_activity_at` = MAX(COALESCE(`last_activity_at`, ''), new.`updated_at`) WHERE `id` = new.`job_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `applications_count_after_delete` AFTER DELETE ON `applications` BEGIN
  UPDATE `jobs` SET `application_count` = `application_count` - 1 WHERE `id` = old.`job_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `applications_activity_after_update` AFTER UPDATE OF `updated_at` ON `applications` BEGIN
  UPDATE `jobs` SET `last_activity_at` = MAX(COALESCE(`last_activity_at`, ''), new.`updated_at`) WHERE `id` = new.`job_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `applications_fts_after_insert` AFTER INSERT ON `applications` BEGIN
  INSERT INTO applications_fts (rowid, memo) VALUES (new.id, new.memo);
END;
--> statement-breakpoint
CREATE TRIGGER `applications_fts_after_delete` AFTER DELETE ON `applications` BEGIN
  INSERT INTO applications_fts (applications_fts, rowid, memo) VALUES ('delete', old.id, old.memo);
END;
--> statement-breakpoint
CREATE TRIGGER `applications_fts_after_update` AFTER UPDATE OF memo ON `applications` BEGIN
  INSERT INTO applications_fts (applications_fts, rowid, memo) VALUES ('delete', old.id, old.memo);
  INSERT INTO applications_fts (rowid, memo) VALUES (new.id, new.memo);
END;
--> statement-breakpoint
-- Any change to a timeline sets the application's stage and furthest stage again, from its steps.
-- A step moved to another application (two copies of a job merged) sets both.
CREATE TRIGGER `application_steps_after_insert` AFTER INSERT ON `application_steps` BEGIN
  UPDATE `applications` SET
    `stage` = COALESCE((SELECT s.`stage` FROM `application_steps` s WHERE s.`application_id` = `applications`.`id` ORDER BY s.`at` DESC, s.`id` DESC LIMIT 1), 'Applied'),
    `furthest_rank` = COALESCE((SELECT MAX(CASE s.`stage` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END) FROM `application_steps` s WHERE s.`application_id` = `applications`.`id`), 0)
  WHERE `id` = new.`application_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `application_steps_after_update` AFTER UPDATE ON `application_steps` BEGIN
  UPDATE `applications` SET
    `stage` = COALESCE((SELECT s.`stage` FROM `application_steps` s WHERE s.`application_id` = `applications`.`id` ORDER BY s.`at` DESC, s.`id` DESC LIMIT 1), 'Applied'),
    `furthest_rank` = COALESCE((SELECT MAX(CASE s.`stage` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END) FROM `application_steps` s WHERE s.`application_id` = `applications`.`id`), 0)
  WHERE `id` IN (old.`application_id`, new.`application_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `application_steps_after_delete` AFTER DELETE ON `application_steps` BEGIN
  UPDATE `applications` SET
    `stage` = COALESCE((SELECT s.`stage` FROM `application_steps` s WHERE s.`application_id` = `applications`.`id` ORDER BY s.`at` DESC, s.`id` DESC LIMIT 1), 'Applied'),
    `furthest_rank` = COALESCE((SELECT MAX(CASE s.`stage` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END) FROM `application_steps` s WHERE s.`application_id` = `applications`.`id`), 0)
  WHERE `id` = old.`application_id`;
END;
