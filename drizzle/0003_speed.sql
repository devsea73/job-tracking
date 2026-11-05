ALTER TABLE `applications` ADD `furthest_rank` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `application_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `last_activity_at` text;--> statement-breakpoint
CREATE INDEX `jobs_application_count_idx` ON `jobs` (`application_count`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_last_activity_idx` ON `jobs` (`last_activity_at`,`id`);
--> statement-breakpoint
UPDATE `jobs` SET
  `application_count` = (SELECT COUNT(*) FROM `applications` a WHERE a.`job_id` = `jobs`.`id`),
  `last_activity_at` = MAX(`updated_at`, COALESCE((SELECT MAX(a.`updated_at`) FROM `applications` a WHERE a.`job_id` = `jobs`.`id`), ''));
--> statement-breakpoint
UPDATE `applications` SET `furthest_rank` = (
  SELECT COALESCE(MAX(CASE h.`new_status` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END), 0)
  FROM `application_status_history` h WHERE h.`application_id` = `applications`.`id`
);
--> statement-breakpoint
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
CREATE TRIGGER `jobs_activity_after_insert` AFTER INSERT ON `jobs` BEGIN
  UPDATE `jobs` SET `last_activity_at` = new.`updated_at` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_activity_after_update` AFTER UPDATE OF `updated_at` ON `jobs` BEGIN
  UPDATE `jobs` SET `last_activity_at` = MAX(COALESCE(`last_activity_at`, ''), new.`updated_at`) WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `status_history_furthest_after_insert` AFTER INSERT ON `application_status_history` BEGIN
  UPDATE `applications` SET `furthest_rank` = MAX(`furthest_rank`, CASE new.`new_status` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END)
  WHERE `id` = new.`application_id`;
END;
--> statement-breakpoint
DROP TRIGGER `jobs_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER `jobs_fts_after_delete`;
--> statement-breakpoint
DROP TRIGGER `jobs_fts_after_update`;
--> statement-breakpoint
DROP TABLE `jobs_fts`;
--> statement-breakpoint
-- Prefix indexes answer "snow*" from the index itself, instead of walking every matching term.
CREATE VIRTUAL TABLE `jobs_fts` USING fts5(
  company_name,
  title,
  description,
  content = 'jobs',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
);
--> statement-breakpoint
INSERT INTO `jobs_fts` (`jobs_fts`) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_after_insert` AFTER INSERT ON `jobs` BEGIN
  INSERT INTO jobs_fts (rowid, company_name, title, description)
  VALUES (new.id, new.company_name, new.title, new.description);
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_after_delete` AFTER DELETE ON `jobs` BEGIN
  INSERT INTO jobs_fts (jobs_fts, rowid, company_name, title, description)
  VALUES ('delete', old.id, old.company_name, old.title, old.description);
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_after_update` AFTER UPDATE OF company_name, title, description ON `jobs` BEGIN
  INSERT INTO jobs_fts (jobs_fts, rowid, company_name, title, description)
  VALUES ('delete', old.id, old.company_name, old.title, old.description);
  INSERT INTO jobs_fts (rowid, company_name, title, description)
  VALUES (new.id, new.company_name, new.title, new.description);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `applications_fts` USING fts5(
  memo,
  content = 'applications',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
);
--> statement-breakpoint
INSERT INTO `applications_fts` (`applications_fts`) VALUES ('rebuild');
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
