import type { RequestEntry, Snapshot } from './types.js';
export type LinearIssue = { id: string; identifier: string; createdAt: string; archivedAt: string | null; description: string | null; team: { id: string; key: string } };
const issueFields = 'id identifier createdAt archivedAt description team { id key }';
export class Linear {
  constructor(readonly token: string, readonly log: RequestEntry[], readonly dryRun = false) {}
  async query<T = any>(operation: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const write = /^\s*mutation\b/.test(query);
    if (write && this.dryRun) throw new Error(`Dry run blocked Linear write: ${operation}`);
    this.log.push({ app: 'linear', method: 'POST', path: operation, at: new Date().toISOString(), write });
    const response = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: this.token, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Linear ${operation}: HTTP ${response.status}`);
    const result = await response.json() as any;
    if (result.errors?.length || !result.data) throw new Error(`Linear ${operation}: GraphQL operation failed`);
    if (write && Object.values(result.data).some((x: any) => x?.success === false)) throw new Error(`Linear ${operation}: mutation rejected`);
    return result.data as T;
  }
  async connection(operation: string, query: string, variables: Record<string, unknown>, field: string): Promise<any[]> {
    const nodes: any[] = []; let after: string | null = null;
    do {
      const data: Record<string, any> = await this.query(operation, query, { ...variables, after });
      const page: { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } = data[field]; nodes.push(...page.nodes);
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) throw new Error(`Linear ${operation}: missing cursor`);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return nodes;
  }
  async team(key: string): Promise<string> {
    const teams = await this.connection('teams', 'query Teams($after:String) { teams(first:100, after:$after) { nodes { id key } pageInfo { hasNextPage endCursor } } }', {}, 'teams');
    const team = teams.find(x => x.key === key); if (!team) throw new Error(`Linear team not found: ${key}`); return team.id;
  }
  async issues(teamId: string, needle: string): Promise<LinearIssue[]> {
    return this.connection('issues', `query Issues($team:ID!, $needle:String!, $after:String) { issues(first:100, after:$after, filter:{team:{id:{eq:$team}},description:{contains:$needle}}) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`, { team: teamId, needle }, 'issues');
  }
  async lookup(pr: Pick<Snapshot, 'repo' | 'number' | 'html_url'>, teamId: string): Promise<{ issue?: LinearIssue; duplicates: string[]; attached: boolean }> {
    const nodes = await this.connection('attachmentsForURL', `query Attachments($url:String!, $after:String) { attachmentsForURL(url:$url, first:100, after:$after) { nodes { issue { ${issueFields} } } pageInfo { hasNextPage endCursor } } }`, { url: pr.html_url }, 'attachmentsForURL');
    let candidates: LinearIssue[] = nodes.map(x => x.issue).filter(x => x && !x.archivedAt && x.team.id === teamId);
    const attached = candidates.length > 0;
    if (!attached) {
      const key = `tsuzuki-pr: ${pr.repo}#${pr.number}`;
      candidates = (await this.issues(teamId, key)).filter(x => !x.archivedAt && x.description?.split('\n').includes(key));
    }
    const sorted = [...new Map(candidates.map(x => [x.id, x])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { issue: sorted[0], duplicates: sorted.slice(1).map(x => x.identifier), attached };
  }
  async sync(pr: Snapshot, teamId: string, sentence: string, outcome?: string): Promise<string[]> {
    const found = await this.lookup(pr, teamId);
    if (this.dryRun) return found.duplicates;
    const description = `tsuzuki-pr: ${pr.repo}#${pr.number}\n\n${sentence}\n\n${pr.html_url}\n\nOutcome: ${outcome ?? 'pending'}`;
    let id = found.issue?.id;
    if (id) {
      if (found.issue!.description !== description) await this.query('issueUpdate', 'mutation Update($id:String!, $input:IssueUpdateInput!) { issueUpdate(id:$id,input:$input) { success } }', { id, input: { description } });
    } else {
      const result = await this.query('issueCreate', 'mutation Create($input:IssueCreateInput!) { issueCreate(input:$input) { success issue { id } } }', { input: { teamId, title: `Tsuzuki: ${pr.repo}#${pr.number}`, description } });
      id = result.issueCreate.issue.id;
    }
    if (!found.attached) await this.query('attachmentCreate', 'mutation Attach($input:AttachmentCreateInput!) { attachmentCreate(input:$input) { success } }', { input: { issueId: id, title: `Pull request #${pr.number}`, url: pr.html_url } });
    return found.duplicates;
  }
}
