import type { Analysis, Marker, Outcome, Snapshot } from './types.js';
export function measure(pr: Snapshot, analysis: Analysis, marker: Marker): Outcome {
  if (analysis.skip || pr.mergeable === null) return 'pending';
  if (['checks_failing', 'cla_pending'].includes(marker.blocker)) {
    const reported = marker.checks.some(name => pr.checks.some(x => x.name === name && x.conclusion !== null)
      || pr.statuses.some(x => x.context === name && ['success', 'failure', 'error'].includes(x.state)));
    if (!reported) return 'pending';
  }
  if (!analysis.blockers.some(x => x.kind === marker.blocker)) return 'cleared';
  return pr.head_sha !== marker.head_sha ? 'pushed' : 'stalled';
}
