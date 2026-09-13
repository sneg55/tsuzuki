import { Octokit } from '@octokit/rest';
import type { RequestEntry, Snapshot } from './types.js';
import { parseConfig, repoParts, type Config } from './config.js';
export const COURT_LABELS = ['tsuzuki:contributor', 'tsuzuki:maintainer'];
export type Params = Record<string, unknown>;
export function allowedGitHubWrite(method: string, path: string, body: Params): boolean {
  const p = decodeURIComponent(path.split('?')[0]!);
  if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(p)) return typeof body.body === 'string';
  if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/.test(p)) return Array.isArray(body.labels) && body.labels.length > 0 && body.labels.every(x => COURT_LABELS.includes(String(x)));
  if (method === 'DELETE' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels\/tsuzuki:(contributor|maintainer)$/.test(p)) return true;
  return method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(p) && COURT_LABELS.includes(String(body.name));
}
export class GitHub {
  readonly octokit: Octokit;
  constructor(token: string, readonly login: string, readonly log: RequestEntry[], readonly dryRun = false, admin = false) {
    this.octokit = new Octokit({ auth: token, request: { timeout: 30_000 } });
    this.octokit.hook.wrap('request', async (request, options) => {
      const endpoint = this.octokit.request.endpoint(options);
      const path = new URL(endpoint.url).pathname;
      const write = !['GET', 'HEAD'].includes(endpoint.method);
      let body: Params = {};
      if (endpoint.body) body = typeof endpoint.body === 'string' ? JSON.parse(endpoint.body) as Params : endpoint.body as Params;
      if (write && this.dryRun) throw new Error(`Dry run blocked GitHub write: ${endpoint.method} ${path}`);
      if (write && !admin && !allowedGitHubWrite(endpoint.method, path, body)) throw new Error(`Forbidden GitHub write: ${endpoint.method} ${path}`);
      this.log.push({ app: 'github', method: endpoint.method, path, at: new Date().toISOString(), write });
      return request(options);
    });
  }
  async call<T = any>(route: string, params: Params = {}): Promise<T> {
    return (await this.octokit.request(route, params)).data as T;
  }
  async list<T = any>(route: string, params: Params = {}): Promise<T[]> {
    return await this.octokit.paginate(route, { ...params, per_page: 100 }) as T[];
  }
  async config(repo: string): Promise<Config | null> {
    try {
      const data = await this.call('GET /repos/{owner}/{repo}/contents/{path}', { ...repoParts(repo), path: '.github/tsuzuki.yml' });
      if (data.type !== 'file' || data.encoding !== 'base64') throw new Error('Repository config is not a readable file');
      return parseConfig(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (error) { if (status(error) === 404) return null; throw error; }
  }
  async ensureLabels(repo: string, existing: string[]): Promise<void> {
    for (const name of COURT_LABELS) if (!existing.includes(name)) await this.call('POST /repos/{owner}/{repo}/labels', { ...repoParts(repo), name, color: name.endsWith('contributor') ? 'd29922' : '238636' });
  }
  async comment(pr: Snapshot, body: string): Promise<void> {
    await this.call('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...repoParts(pr.repo), issue_number: pr.number, body });
  }
  async labels(pr: Snapshot, add: string[], remove: string[]): Promise<void> {
    for (const name of remove) await this.call('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...repoParts(pr.repo), issue_number: pr.number, name });
    if (add.length) await this.call('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...repoParts(pr.repo), issue_number: pr.number, labels: add });
  }
}
export function status(error: unknown): number | undefined { return (error as { status?: number })?.status; }
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
