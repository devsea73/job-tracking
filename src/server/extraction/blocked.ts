import type { CheerioAPI } from 'cheerio';

/**
 * Recognizes pages that are not the posting: bot challenges, login walls and "job closed"
 * pages. These must surface as failures, so that their text is never saved as a description.
 */

const CHALLENGE_TITLE =
  /(just a moment|attention required|access denied|are you (a )?human|verify(ing)? you are|security check|please wait|robot check|pardon our interruption|request blocked|captcha|additional verification required)/i;

const CHALLENGE_BODY =
  // Not "g-recaptcha" or "h-captcha": application forms embed those on perfectly normal job pages.
  /(cf-browser-verification|cf_chl_|px-captcha|datadome|distil_r_captcha|incapsula incident|please enable (javascript and )?cookies to continue|verify you are human|unusual traffic from your|checking your browser before|quick security check|confirm you('|&#39;|’)?re human)/i;

/** What a person sees on the page. Cheerio's text() would also count the contents of inline scripts. */
export function visibleText($: CheerioAPI): string {
  const body = $('body').clone();
  body.find('script, style, noscript, template').remove();
  return body.text().replace(/\s+/g, ' ').trim();
}

export function detectBlockedPage($: CheerioAPI, html: string, status: number | null): string | null {
  const title = $('title').first().text().trim();
  const thin = visibleText($).length < 1500;

  if (status === 403 || status === 429 || status === 503 || status === 999) {
    if (CHALLENGE_TITLE.test(title) || CHALLENGE_BODY.test(html) || thin) {
      return `This job site refused the automated request (HTTP ${status}).`;
    }
  }
  if (CHALLENGE_TITLE.test(title)) return 'This job site showed a bot check instead of the posting.';
  if (thin && CHALLENGE_BODY.test(html)) return 'This job site showed a bot check instead of the posting.';
  return null;
}

const LOGIN_TITLE = /^(sign[ -]?in|log[ -]?in|login)\b|\b(sign[ -]?in|log[ -]?in) (to|\|)/i;

export function detectLoginWall($: CheerioAPI): boolean {
  const title = $('title').first().text().trim();
  if (!LOGIN_TITLE.test(title)) return false;
  return $('input[type="password"]').length > 0 || visibleText($).length < 2000;
}

const GONE_TEXT =
  /(this job (posting )?(is|has been) (no longer|closed|removed|filled)|job (posting )?(is )?no longer (available|active|accepting)|no longer accepting applications|position (has been|is) (filled|closed)|the job you are looking for (is|was|has)|this position is no longer|job not found|no job found|page not found|posting (has been )?(closed|removed|expired)|this job has expired|we couldn'?t find (this|that|the) job|job you('| a)re looking for (is|was|has|can)|page you are looking for (doesn'?t|does not|no longer) exist|job does not exist|(not|no longer) currently active|job is not available|opportunity is (no longer|currently not) available)/i;

/** Stated right at the top of a page, these mean the same however long the rest of the page is. */
const GONE_AT_TOP = /(no longer accepting applications|(job|position|opportunity|posting) (is|has been) (no longer available|closed|removed|filled)|(job|position|opportunity) is no longer|this job has expired)/i;

const GONE_TITLE = /(job not found|page not found|not available anymore|no longer available|^404\b|error 404|job (is )?closed)/i;

export function detectClosedPosting(text: string, title = ''): boolean {
  if (GONE_TITLE.test(title)) return true;
  const plain = text.replace(/[’‘]/g, "'");
  // Long pages can mention these phrases in passing; a removed posting is usually a short page.
  if (plain.length < 2500 && GONE_TEXT.test(plain)) return true;
  return GONE_AT_TOP.test(plain.slice(0, 400));
}
