import type { CheerioAPI } from 'cheerio';

/**
 * Recognizes pages that are not the posting: bot challenges, login walls and "job closed"
 * pages. These must surface as failures, so that their text is never saved as a description.
 */

const CHALLENGE_TITLE =
  /(just a moment|attention required|access denied|are you (a )?human|verify(ing)? you are|security check|please wait|robot check|pardon our interruption|request blocked|captcha|additional verification required)/i;

const CHALLENGE_BODY =
  /(cf-browser-verification|cf_chl_|challenge-platform|g-recaptcha|h-captcha|px-captcha|datadome|distil_r_captcha|incapsula incident|please enable (javascript and )?cookies to continue|verify you are human|unusual traffic from your|checking your browser before)/i;

export function detectBlockedPage($: CheerioAPI, html: string, status: number | null): string | null {
  const title = $('title').first().text().trim();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const thin = bodyText.length < 1500;

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
  return $('input[type="password"]').length > 0 || $('body').text().trim().length < 2000;
}

const GONE_TEXT =
  /(this job (posting )?(is|has been) (no longer|closed|removed|filled)|job (posting )?(is )?no longer (available|active|accepting)|no longer accepting applications|position (has been|is) (filled|closed)|the job you are looking for (is|was|has)|this position is no longer|job not found|page not found|posting (has been )?(closed|removed)|we couldn'?t find (this|that|the) job|job you('| a)re looking for (is|was|has|can))/i;

export function detectClosedPosting(text: string): boolean {
  // Long pages can mention these phrases in passing; a removed posting is a short page.
  return text.length < 2500 && GONE_TEXT.test(text);
}
