import { z } from 'zod';
import { blockerKinds, type Blocker, type Marker } from './types.js';
const schema = z.object({ blocker: z.enum(blockerKinds), checks: z.array(z.string()), also: z.array(z.enum(blockerKinds)), head_sha: z.string().min(1) }).strict();
export function parseMarker(body: string): Marker | null {
  const match = /<!-- tsuzuki v1 (\{[^\n]*\}) -->\s*$/.exec(body);
  if (!match) return null;
  try { return schema.parse(JSON.parse(match[1]!)); } catch { return null; }
}
export function makeMarker(blockers: Blocker[], sha: string): Marker {
  const primary = blockers[0]; if (!primary) throw new Error('Cannot mark an empty blocker set');
  return { blocker: primary.kind, checks: ['cla_pending', 'checks_failing'].includes(primary.kind) ? primary.artifacts : [], also: blockers.slice(1).map(x => x.kind), head_sha: sha };
}
export function markerLine(marker: Marker): string { return `<!-- tsuzuki v1 ${JSON.stringify(marker).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')} -->`; }
