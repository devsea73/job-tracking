// Prints a load-test report, or compares two: node scripts/show-load-report.mjs load-report.json [load-report.before.json]
import { readFileSync } from 'node:fs';

const [file = 'load-report.json', baselineFile] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, 'utf8'));
const baseline = baselineFile ? new Map(JSON.parse(readFileSync(baselineFile, 'utf8')).rows.map((row) => [row.name, row])) : null;

console.log(`Data: ${JSON.stringify(report.counts)}`);
console.log(`Seeded in ${(report.seedMs / 1000).toFixed(1)}s. Database: ${report.dbMb.toFixed(0)} MB.\n`);
const width = Math.max(...report.rows.map((row) => row.name.length));
const cell = (value, size = 8) => String(value ?? '').padStart(size);
console.log(`${'request'.padEnd(width)}  ${baseline ? `${cell('was p50')}  ` : ''}${cell('p50 ms')}  ${cell('p95 ms')}  ${cell('max ms')}  ${cell('size KB')}  ${cell('results')}`);
for (const row of report.rows) {
  const before = baseline?.get(row.name);
  console.log(`${row.name.padEnd(width)}  ${baseline ? `${cell(before?.p50)}  ` : ''}${cell(row.p50)}  ${cell(row.p95)}  ${cell(row.max)}  ${cell(row.kb)}  ${cell(row.count)}`);
}
