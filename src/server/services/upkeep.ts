import type { AppContext } from '../context';
import { cleanSavedLinks, reindexJobs, repairHtmlDescriptions } from './job-facts-store';
import { reconcileJobIdentities } from './job-merge';

/**
 * Brings saved data up to the current rules: descriptions saved as markup turned into text,
 * personal tokens taken out of saved links, jobs indexed for duplicate detection, and ids in old
 * links recorded. Runs at every start, and after a backup is restored, since a backup can be
 * older than any of these rules. Each step does nothing once its work is done.
 */
export async function prepareSavedData(ctx: AppContext, options: { backup?: () => Promise<unknown> } = {}): Promise<void> {
  const sqlite = ctx.handle.sqlite;
  const repaired = repairHtmlDescriptions(sqlite);
  if (repaired > 0) ctx.logger.info({ repaired }, 'Turned descriptions saved as markup into text');
  const cleanedLinks = cleanSavedLinks(sqlite);
  if (cleanedLinks > 0) ctx.logger.info({ cleanedLinks }, 'Removed visitor tracking from saved links');
  const reindexed = reindexJobs(sqlite);
  if (reindexed > 0) ctx.logger.info({ reindexed }, 'Indexed saved jobs for duplicate detection');
  await reconcileJobIdentities(ctx, { backup: options.backup });
}
