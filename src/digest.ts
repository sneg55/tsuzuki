import type { RunRow, Snapshot } from './types.js';
export function digest(repo: string, now: string, rows: RunRow[], snapshots: Snapshot[], ignored: number, dryRun: boolean): string {
  const lines = [`Tsuzuki, ${repo}, run ${now}${dryRun ? ' (dry run)' : ''}`];
  const nudged = rows.filter(x => x.nudged);
  const unsure = rows.filter(x => x.decision.court === 'unsure');
  const skipped = rows.filter(x => !x.nudged && x.decision.court !== 'unsure');
  lines.push(`Nudged ${nudged.length}`);
  for (const row of nudged) lines.push(`  #${row.number}  ${row.decision.blockers.map(x => `${x.kind}: ${x.artifacts.join(', ')}`).join('; ')}  ${row.sentence}`);
  lines.push(`Skipped ${skipped.length}`);
  for (const row of skipped) lines.push(`  #${row.number}  ${row.decision.reason}${row.decision.reason === 'quiet_hours' ? `  local hour ${row.decision.local_hour}` : ''}${row.decision.blockers.length ? `  ${row.decision.blockers.map(x => `${x.kind}: ${x.artifacts.join(', ')}`).join('; ')}` : ''}`);
  lines.push(`Unsure ${unsure.length}`);
  for (const row of unsure) lines.push(`  #${row.number}  ${row.decision.signals.map(x => `${x.kind}: ${x.detail}`).join('; ')}`);
  const outcomes = rows.filter(x => x.outcome);
  lines.push('Outcome since last run', `  ${outcomes.length} carrying a prior marker: ${['cleared', 'pushed', 'pending', 'stalled'].map(outcome => `${outcome} ${outcomes.filter(x => x.outcome === outcome).length}`).join(', ')}`);
  for (const row of outcomes) lines.push(`  #${row.number}  ${row.outcome}`);
  for (const row of rows) {
    if (row.errors.length) lines.push(`Partial #${row.number}: ${row.errors.join('; ')}`);
    if (row.duplicates.length) lines.push(`Duplicates #${row.number}: ${row.duplicates.join(', ')}`);
  }
  const noTimezone = rows.filter(x => x.decision.timezone_unavailable).map(x => `#${x.number}`);
  if (noTimezone.length) lines.push(`Timezone unavailable (no quiet-hours gate): ${noTimezone.join(', ')}`);
  const noProtection = snapshots.filter(x => x.protection_unavailable).map(x => `#${x.number}`);
  if (noProtection.length) lines.push(`Required-check protection unavailable: ${noProtection.join(', ')}`);
  lines.push(`Template fallbacks: ${rows.filter(x => x.fallback).length}`, `Ignored commands: ${ignored}`,
    'Reply in thread with "skip #N", "skip @login", "unskip #N" or "unskip @login".',
    'React :no_entry_sign: on the pinned ledger to pause.');
  return lines.join('\n');
}
