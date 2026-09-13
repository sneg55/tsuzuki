import { configSchema } from '../src/config.js';
import type { Snapshot } from '../src/types.js';
export const NOW = '2026-09-13T16:00:00.000Z';
export const config = configSchema.parse({ slack: { channel: 'C123', maintainers: ['UADMIN'] }, linear: { team_key: 'OSS' } });
export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { repo: 'owner/repo', number: 4, html_url: 'https://github.com/owner/repo/pull/4', draft: false, labels: [], author: 'contributor', author_type: 'User', base_ref: 'main', updated_at: '2026-08-01T12:00:00Z', mergeable: true, mergeability_polls: 0, head_sha: 'abc123', head_committed_at: '2099-01-01T00:00:00Z', head_tz_offset: 0, checks: [], statuses: [], required_checks: [], protection_unavailable: false, reviews: [], timeline: [], comments: [], ...overrides };
}
export const failed = { name: 'ci / test (ubuntu)', status: 'completed', conclusion: 'failure', started_at: '2026-08-01T12:00:00Z' };
