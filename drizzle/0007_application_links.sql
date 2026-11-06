-- Which link each application was added with, so that a notice about it offers that very link.
ALTER TABLE `applications` ADD `job_url_id` integer REFERENCES job_urls(id) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `applications_job_url_idx` ON `applications` (`job_url_id`);
--> statement-breakpoint
-- Applications made before this were saved in one go with the link that was new then. One saved
-- within two seconds of the application is that link; any other application is left without one.
UPDATE `applications` SET `job_url_id` = (
  SELECT u.`id` FROM `job_urls` u
  WHERE u.`job_id` = `applications`.`job_id` AND u.`kind` = 'original'
    AND ABS(julianday(u.`created_at`) - julianday(`applications`.`applied_at`)) * 86400 <= 2
  ORDER BY ABS(julianday(u.`created_at`) - julianday(`applications`.`applied_at`)), u.`id`
  LIMIT 1
);
