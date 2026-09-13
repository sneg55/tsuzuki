import type { RunRow, Snapshot } from './types.js';
function blockers(row: RunRow): string {
  return row.decision.blockers.map(x => `${x.kind}: ${x.artifacts.join(', ')}`).join('; ');
}
function skipDetail(row: RunRow): string {
  const hour = row.decision.reason === 'quiet_hours' ? `  local hour ${row.decision.local_hour}` : '';
  return `${row.decision.reason}${hour}${row.decision.blockers.length ? `  ${blockers(row)}` : ''}`;
}
function references(numbers: number[]): string {
  return [...numbers].sort((a, b) => a - b).map(x => `#${x}`).join(', ');
}
export function digest(repo: string, now: string, rows: RunRow[], snapshots: Snapshot[], ignored: number, dryRun: boolean): string {
  const lines = [`Tsuzuki, ${repo}, run ${now}${dryRun ? ' (dry run)' : ''}`];
  const nudged = rows.filter(x => x.nudged);
  const unsure = rows.filter(x => x.decision.court === 'unsure');
  const skipped = rows.filter(x => !x.nudged && x.decision.court !== 'unsure');
  lines.push('', `*Nudged ${nudged.length}*`);
  for (const row of nudged) lines.push(`  #${row.number}  ${row.decision.blockers.map(x => x.kind).join('; ')}  ${row.sentence}`);
  lines.push('', `*Skipped ${skipped.length}*`);
  const grouped = new Map<string, number[]>();
  for (const row of skipped) {
    const detail = skipDetail(row);
    grouped.set(detail, [...(grouped.get(detail) ?? []), row.number]);
  }
  for (const [detail, numbers] of grouped) lines.push(`  ${references(numbers)}  ${detail}`);
  lines.push('', `*Unsure ${unsure.length}*`);
  for (const row of unsure) lines.push(`  #${row.number}  ${row.decision.signals.map(x => `${x.kind}: ${x.detail}`).join('; ')}`);
  const outcomes = rows.filter(x => x.outcome);
  lines.push('', '*Outcome since last run*',
    `  ${outcomes.length} carrying a prior marker: ${['cleared', 'pushed', 'pending', 'stalled'].map(outcome => `${outcome} ${outcomes.filter(x => x.outcome === outcome).length}`).join(', ')}`);
  for (const row of outcomes) lines.push(`  #${row.number}  ${row.outcome}`);
  const notes: string[] = [];
  for (const row of rows) {
    if (row.errors.length) notes.push(`Partial #${row.number}: ${row.errors.join('; ')}`);
    if (row.duplicates.length) notes.push(`Duplicates #${row.number}: ${row.duplicates.join(', ')}`);
  }
  const noTimezone = rows.filter(x => x.decision.timezone_unavailable).map(x => `#${x.number}`);
  if (noTimezone.length) notes.push(`Timezone unavailable (no quiet-hours gate): ${noTimezone.join(', ')}`);
  const noProtection = snapshots.filter(x => x.protection_unavailable).map(x => `#${x.number}`);
  if (noProtection.length) notes.push(`Required-check protection unavailable: ${noProtection.join(', ')}`);
  if (notes.length) lines.push('', ...notes);
  lines.push('', `Template fallbacks: ${rows.filter(x => x.fallback).length} | Ignored commands: ${ignored}`,
    'Reply in thread with "skip #N", "skip @login", "unskip #N" or "unskip @login".',
    'React :no_entry_sign: on the pinned ledger to pause.');
  return lines.join('\n');
}
