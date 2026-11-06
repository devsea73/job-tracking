-- The numbers pages read a range of days, not every row: applications by when they were made,
-- stages by when they were reached, interviews by when they were booked. The furthest stage counts
-- each profile's applications that got somewhere, and finds the offers, which count from the start.
-- The latest applications are listed straight from the first.
CREATE INDEX `applications_applied_idx` ON `applications` (`applied_at`);
--> statement-breakpoint
CREATE INDEX `applications_furthest_idx` ON `applications` (`furthest_rank`,`profile_id`);
--> statement-breakpoint
CREATE INDEX `status_history_reached_idx` ON `application_status_history` (`new_status`,`changed_at`,`application_id`);
--> statement-breakpoint
CREATE INDEX `interviews_created_idx` ON `interviews` (`created_at`,`application_id`);
