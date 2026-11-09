-- One idea for where an application is: a stage. Each application has a timeline of steps, each a
-- stage and the moment it takes place, as the person entered it: an interview at an interview stage
-- (three technical rounds are three steps), an offer or a rejection on the day it came. This takes
-- the place of the status, its history, and the interviews' own stages.
-- The existing interviews and status changes are copied in by the app straight after this runs
-- (see src/server/db/steps-from-history.ts); 0010 then works each application's stage out from them.
CREATE TABLE `application_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`stage` text NOT NULL,
	`at` text NOT NULL,
	`timezone` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "application_steps_stage_check" CHECK("stage" in ('Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer', 'Rejected'))
);
--> statement-breakpoint
CREATE INDEX `application_steps_application_idx` ON `application_steps` (`application_id`,`at`);
--> statement-breakpoint
CREATE INDEX `application_steps_at_idx` ON `application_steps` (`at`);
--> statement-breakpoint
CREATE INDEX `application_steps_stage_at_idx` ON `application_steps` (`stage`,`at`,`application_id`);
