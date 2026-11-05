-- Full-text index over the shared job fields. Memos are deliberately not indexed here:
-- they are private, so they are only ever searched row-by-row within the current user's
-- own applications.
CREATE VIRTUAL TABLE `jobs_fts` USING fts5(
  company_name,
  title,
  description,
  content = 'jobs',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);
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
