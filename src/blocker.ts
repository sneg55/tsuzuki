import type { Config } from './config.js';
import type { Analysis, Blocker, Snapshot, Suppressions } from './types.js';
export function analyze(pr: Snapshot, config: Config, suppressed: Suppressions, now: string): Analysis {
  const skip = pr.draft ? 'draft' : pr.author_type === 'Bot' ? 'bot_author'
    : config.skip_authors.some(x => x.toLowerCase() === pr.author.toLowerCase()) ? 'skip_author'
    : pr.labels.some(x => config.skip_labels.includes(x)) ? 'skipped_label'
    : suppressed.prs.includes(pr.number) || suppressed.logins.some(x => x.toLowerCase() === pr.author.toLowerCase()) ? 'never_contact' : null;
  if (skip) return { skip, court: null, blockers: [], signals: [] };
  const blockers: Blocker[] = [];
  const cla = [...pr.checks.filter(x => config.cla_check_names.includes(x.name) && x.conclusion !== 'success').map(x => x.name),
    ...pr.statuses.filter(x => config.cla_check_names.includes(x.context) && x.state !== 'success').map(x => x.context)];
  if (cla.length) blockers.push({ kind: 'cla_pending', artifacts: [...new Set(cla)].sort(), dates: [] });
  const optional = (name: string) => config.optional_check_patterns.some(x => new RegExp(x).test(name));
  const failed = [...pr.checks.filter(x => ['failure', 'timed_out', 'cancelled'].includes(x.conclusion ?? '') && !optional(x.name)).map(x => ({ name: x.name, at: x.started_at })),
    ...pr.statuses.filter(x => ['failure', 'error'].includes(x.state) && !optional(x.context)).map(x => ({ name: x.context, at: null }))];
  const failures = [...new Map(failed.map(x => [x.name, x])).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (failures.length) blockers.push({ kind: 'checks_failing', artifacts: failures.map(x => x.name), dates: failures.map(x => x.at) });
  if (pr.mergeable === false) blockers.push({ kind: 'merge_conflict', artifacts: [pr.base_ref], dates: [] });
  const latest = pr.reviews.filter(x => x.author_type === 'User').sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0];
  if (latest?.state === 'CHANGES_REQUESTED' && latest.commit_id === pr.head_sha)
    blockers.push({ kind: 'changes_requested', artifacts: [latest.author], dates: [latest.submitted_at] });
  const signals: Analysis['signals'] = [];
  if (!blockers.length) {
    const pending = pr.checks.filter(x => pr.required_checks.includes(x.name) && ['queued', 'in_progress'].includes(x.status) && x.started_at && Date.parse(now) - Date.parse(x.started_at) > config.unsure_after_hours * 3_600_000);
    if (pending.length) signals.push({ kind: 'checks_pending', artifacts: pending.map(x => x.name).sort(), detail: pending.map(x => `${x.name}: ${x.status}, started ${x.started_at}`).join('; ') });
    if (pr.mergeable === null) signals.push({ kind: 'mergeability_unknown', artifacts: [], detail: `${pr.mergeability_polls} polls attempted` });
  }
  return { skip: null, blockers, signals, court: blockers.length ? 'contributor' : signals.length ? 'unsure' : 'maintainer' };
}
