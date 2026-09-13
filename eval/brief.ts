import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { args } from '../src/runtime.js';
import { controls } from './controls.js';
import type { EvalReport } from './runner.js';
export function brief(report: EvalReport): string {
  const lines = [`# Tsuzuki reliability brief`, '', `Repository: ${report.repo}. Evidence: ${report.evidence} provider runs.`, '', '| Control | Results | Verdict |', '|---|---|---|'];
  let mixed = 0;
  for (const control of controls) {
    const results = Array.from({ length: report.repeats }, (_, index) => {
      const matches = report.results.filter(x => x.control === control && x.repeat === index + 1);
      return matches.length === 1 ? matches[0]!.verdict : 'error';
    });
    const varying = new Set(results).size > 1; if (varying) mixed++;
    lines.push(`| ${control} | ${results.join(', ')} | ${varying ? 'mixed (failure)' : results[0]} |`);
  }
  const measured = report.runs.filter(run => run.determinism !== null);
  const phrases = report.runs.flatMap(x => x.phrases); const groups = new Map<string, Set<string>>();
  for (const row of phrases) { const set = groups.get(row.key) ?? new Set<string>(); set.add(row.sentence); groups.set(row.key, set); }
  lines.push('', `Mixed controls: ${mixed}. Missing results are errors. Duplicate results are errors.`, '',
    `Decision determinism: ${measured.length ? measured.every(x => x.determinism) ? 'PASS' : 'FAIL' : 'NOT MEASURED'} (${measured.length} recordings with decision inputs, 100 replays each using recorded policy, ledger, snapshot, and now).`,
    'Live repeat agreement is reported separately in the control table.', '',
    `Phrasing: ${phrases.length} sentences; ${phrases.filter(x => x.fallback).length} template fallbacks (${phrases.length ? (100 * phrases.filter(x => x.fallback).length / phrases.length).toFixed(1) : '0'}%); distinct sentences per unchanged blocker set: ${[...groups.values()].map(x => x.size).join(', ') || 'not measured'}.`, '',
    `Provider requests including fixture resets and witnesses: ${report.provider_requests}.`,
    `Agent request counts per run: ${report.runs.map(x => x.requests).join(', ') || 'no completed recordings'}.`, '', 'Prebuilt disclosure:', ...report.prebuilt.map(x => `- ${x}`), '',
    'Limitations: the Slack ledger has no atomic compare-and-swap; invocations must be serialized by the scheduler. Unit tests are not live integration evidence.');
  return lines.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = args({ input: { type: 'string' } });
  const report = JSON.parse(await readFile(String(options.input ?? 'artifacts/eval/eval.json'), 'utf8')) as EvalReport;
  const text = brief(report);
  if (options.output) await writeFile(String(options.output), text); else console.log(text);
}
