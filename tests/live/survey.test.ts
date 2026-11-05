import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { identifyAts, sourcePlatform } from '../../src/server/dedupe/ats';
import { normalizeUrl, parseUserUrl, stripPersonalParams } from '../../src/server/dedupe/url-normalize';
import { PlaywrightRenderer } from '../../src/server/extraction/browser';
import { extractJob } from '../../src/server/extraction/pipeline';
import { SafeHttpClient } from '../../src/server/extraction/safe-fetch';

/**
 * Runs the extraction pipeline over a list of real links, one per line, and writes
 * survey-report.json. Lines that are not links ("Glassdoor easy apply") are skipped.
 *
 *   npm run survey -- --file C:\path\job.txt [--sample 10] [--providers a,b] [--concurrency 8] [--no-browser]
 *
 * The list stays outside the repository: real links can carry personal tokens.
 */

interface Options {
  file: string;
  sample: number | null;
  providers: string[] | null;
  concurrency: number;
  browser: boolean;
  out: string;
}

function readOptions(): Options {
  const args = (process.env.SURVEY_ARGS ?? '').split(' ').filter(Boolean);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const file = value('--file') ?? process.env.SURVEY_FILE;
  if (!file) throw new Error('Pass the list of links: npm run survey -- --file C:\\path\\job.txt');
  return {
    file,
    sample: value('--sample') ? Number(value('--sample')) : null,
    providers: value('--providers')?.split(',') ?? null,
    concurrency: Number(value('--concurrency') ?? 8),
    browser: !args.includes('--no-browser'),
    out: value('--out') ?? 'survey-report.json'
  };
}

test('extraction survey', async () => {
  const options = readOptions();
  const unique = new Map<string, { url: string; provider: string }>();
  let skipped = 0;
  for (const line of readFileSync(options.file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = parseUserUrl(text);
      if (!/^https?:\/\/|^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text)) throw new Error('not a link');
      const key = normalizeUrl(parsed);
      if (!unique.has(key)) unique.set(key, { url: stripPersonalParams(parsed), provider: sourcePlatform(parsed) });
    } catch {
      skipped += 1;
    }
  }

  let targets = [...unique.values()];
  if (options.providers) targets = targets.filter((target) => options.providers?.includes(target.provider));
  if (options.sample) {
    const seen = new Map<string, number>();
    targets = targets.filter((target) => {
      const count = seen.get(target.provider) ?? 0;
      seen.set(target.provider, count + 1);
      return count < (options.sample as number);
    });
  }
  console.log(`Surveying ${targets.length} links (${unique.size} unique, ${skipped} lines were not links)`);

  const http = new SafeHttpClient();
  const renderer = options.browser ? new PlaywrightRenderer() : null;
  const rows: Array<Record<string, unknown>> = [];
  const busyHosts = new Map<string, number>();
  const queue = [...targets];
  let done = 0;

  // At most two requests at a time per site.
  const takeNext = () => {
    const index = queue.findIndex((target) => (busyHosts.get(new URL(target.url).hostname) ?? 0) < 2);
    return index >= 0 ? queue.splice(index, 1)[0] : null;
  };

  const worker = async () => {
    while (queue.length > 0) {
      const target = takeNext();
      if (!target) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const host = new URL(target.url).hostname;
      busyHosts.set(host, (busyHosts.get(host) ?? 0) + 1);
      const started = Date.now();
      try {
        const result = await extractJob(target.url, { http, renderer });
        rows.push({
          url: target.url,
          provider: target.provider,
          identity: identifyAts(target.url)?.externalId ?? null,
          ms: Date.now() - started,
          ok: result.ok,
          method: result.ok ? result.method : null,
          reason: result.ok ? null : result.reason,
          message: result.ok ? null : result.message,
          title: result.ok ? result.title : result.partial.title,
          company: result.ok ? result.company : result.partial.company,
          location: result.ok ? result.location : result.partial.location,
          descriptionLength: (result.ok ? result.description : result.partial.description)?.length ?? 0,
          descriptionStart: (result.ok ? result.description : result.partial.description)?.slice(0, 160) ?? null,
          descriptionEnd: result.ok ? result.description.slice(-120) : null,
          canonicalUrl: result.canonicalUrl,
          discovered: result.discoveredUrls
        });
      } catch (error) {
        rows.push({ url: target.url, provider: target.provider, ok: false, reason: 'crash', message: String(error), ms: Date.now() - started });
      }
      busyHosts.set(host, (busyHosts.get(host) ?? 1) - 1);
      done += 1;
      if (done % 25 === 0) console.log(`${done}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  await renderer?.close();
  await http.close();

  const summary: Record<string, { total: number; ok: number; reasons: Record<string, number>; methods: Record<string, number> }> = {};
  for (const row of rows) {
    const entry = (summary[row.provider as string] ??= { total: 0, ok: 0, reasons: {}, methods: {} });
    entry.total += 1;
    if (row.ok) {
      entry.ok += 1;
      entry.methods[row.method as string] = (entry.methods[row.method as string] ?? 0) + 1;
    } else {
      entry.reasons[row.reason as string] = (entry.reasons[row.reason as string] ?? 0) + 1;
    }
  }
  const ok = rows.filter((row) => row.ok).length;
  const reasons: Record<string, number> = {};
  for (const row of rows) if (!row.ok) reasons[row.reason as string] = (reasons[row.reason as string] ?? 0) + 1;
  writeFileSync(options.out, JSON.stringify({ total: rows.length, ok, reasons, summary, rows }, null, 2));

  console.log(`\nExtracted ${ok}/${rows.length}. Failures: ${JSON.stringify(reasons)}`);
  for (const [provider, entry] of Object.entries(summary).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`${provider.padEnd(18)} ${String(entry.ok).padStart(4)}/${String(entry.total).padEnd(4)} ${JSON.stringify(entry.methods)} ${JSON.stringify(entry.reasons)}`);
  }
});
