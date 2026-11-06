-- Moving a status back to an earlier stage corrects a mistake, so the later stages no longer
-- count as reached. Only a rejection keeps the furthest stage an application got to.
DROP TRIGGER IF EXISTS `status_history_furthest_after_insert`;
--> statement-breakpoint
CREATE TRIGGER `status_history_furthest_after_insert` AFTER INSERT ON `application_status_history` BEGIN
  UPDATE `applications` SET `furthest_rank` = CASE WHEN new.`new_status` = 'Rejected' THEN MAX(`furthest_rank`, 0) ELSE CASE new.`new_status` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END END
  WHERE `id` = new.`application_id`;
END;
--> statement-breakpoint
UPDATE `applications` SET `furthest_rank` = CASE `status` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END WHERE `status` != 'Rejected' AND `furthest_rank` > CASE `status` WHEN 'Recruiter Screen' THEN 1 WHEN 'Technical Interview' THEN 2 WHEN 'Final Interview' THEN 3 WHEN 'Offer' THEN 4 ELSE 0 END;
