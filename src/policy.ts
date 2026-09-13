import type { Config } from './config.js';
import type { Analysis, Decision, Snapshot } from './types.js';
export function decide(pr: Snapshot, analysis: Analysis, config: Config, now: string): Decision {
  const offset = pr.head_tz_offset;
  const local_hour = offset === null ? null : new Date(Date.parse(now) + offset * 60_000).getUTCHours();
  const desired = analysis.court === 'contributor' ? config.labels.contributor : analysis.court === 'maintainer' ? config.labels.maintainer : null;
  const courtLabels = Object.values(config.labels);
  const add_labels = analysis.skip || !desired || pr.labels.includes(desired) ? [] : [desired];
  const remove_labels = analysis.skip ? [] : pr.labels.filter(x => courtLabels.includes(x as typeof config.labels.contributor) && x !== desired);
  let reason = analysis.skip ?? (analysis.court === 'maintainer' ? 'maintainer_court' : analysis.court === 'unsure' ? 'unsure' : 'nudge');
  if (reason === 'nudge') {
    const nowMs = Date.parse(now);
    const lastActivity = Math.max(Date.parse(pr.updated_at), ...pr.timeline.filter(x => x.actor_type === 'User').map(x => Date.parse(x.at)).filter(Number.isFinite));
    const latestComment = Math.max(-Infinity, ...pr.comments.map(x => Date.parse(x.created_at)));
    const { start, end } = config.quiet_hours;
    const quiet = local_hour !== null && (start < end ? local_hour >= start && local_hour < end : start > end && (local_hour >= start || local_hour < end));
    if (!Number.isFinite(lastActivity) || nowMs - lastActivity <= config.nudge_after_days * 86_400_000) reason = 'fresh_activity';
    else if (nowMs - latestComment <= config.min_gap_days * 86_400_000) reason = 'frequency_cap';
    else if (quiet) reason = 'quiet_hours';
  }
  return { ...analysis, nudge: reason === 'nudge', reason, local_hour, timezone_unavailable: offset === null, add_labels, remove_labels };
}
