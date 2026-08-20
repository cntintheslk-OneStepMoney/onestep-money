import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const canonicalFields = ['Project', 'Priority', 'Complexity', 'Title', 'Status', 'Type', 'Target Release', 'Area', 'Branch', 'Start Date', 'Target Date'];
const lifecycle = ['Idea', 'Backlog', 'Planned', 'In Progress', 'Review', 'Done'];
const projectTypes = ['Feature', 'Bug', 'UI/UX', 'Security', 'QOL', 'Maintenance'];

function normaliseExtractedValue(value) {
  if (value === undefined || value === null) return undefined;
  let cleaned = String(value).trim().replace(/^`|`$/g, '').trim();
  cleaned = cleaned.replace(/^(?:\*{1,2}|_{1,2})(.+?)(?:\*{1,2}|_{1,2})$/, '$1').trim();
  if (!cleaned || /^\(?blank\b/i.test(cleaned)) return undefined;
  return cleaned;
}

export function extract(body, label) {
  if (!body) return undefined;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = new RegExp(`^\\s*(?:(?:#{1,4}|[-*]|\\d+[.)])\\s+)?\\*{0,2}${escaped}\\*{0,2}\\s*:\\*{0,2}\\s*(.*)$`, 'i');
  const heading = new RegExp(`^\\s*#{1,4}\\s+\\*{0,2}${escaped}\\*{0,2}\\s*$`, 'i');
  const lines = String(body).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(inline);
    if (match) return normaliseExtractedValue(match[1]);
    if (heading.test(lines[index])) return normaliseExtractedValue(lines[index + 1]);
  }
  return undefined;
}

function workTypeFromTitle(title = '') {
  const match = title.match(/^\[Work\]\[([^\]]+)\]/i);
  if (!match) return undefined;
  return projectTypes.find(value => value.toLowerCase() === match[1].toLowerCase());
}

function isFutureDesignBrief(title = '') {
  return title.includes('[Design Brief][Future]') || title.includes('[Future Design Brief]');
}

export function deriveIssueMetadata(issue, facts = {}) {
  const body = issue.body ?? '';
  const status = facts.merged || issue.state === 'closed'
    ? 'Done'
    : facts.reviewReady
      ? 'Review'
      : facts.branch
        ? 'In Progress'
        : extract(body, 'Status') ?? (isFutureDesignBrief(issue.title) ? 'Backlog' : 'Planned');
  const metadata = {
    Project: facts.project,
    Priority: extract(body, 'Priority'),
    Complexity: extract(body, 'Complexity'),
    Status: status,
    Type: extract(body, 'Type') ?? workTypeFromTitle(issue.title),
    'Target Release': extract(body, 'Target Release') ?? issue.title.match(/\[v(\d+\.\d+\.\d+)\]/i)?.[1]?.replace(/^/, 'v'),
    Area: extract(body, 'Area'),
    Branch: facts.branch,
    'Start Date': facts.startDate,
    'Target Date': extract(body, 'Target Date')
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined && value !== ''));
}

export function validateProjectSchema(fields, areas = []) {
  const errors = [];
  for (const name of canonicalFields) if (!fields[name]) errors.push(`missing Project field: ${name}`);
  const statusOptions = fields.Status?.options?.map(option => option.name) ?? [];
  for (const value of lifecycle) if (!statusOptions.includes(value)) errors.push(`missing Status option: ${value}`);
  if (areas.length && !areas.every(area => typeof area === 'string' && area.trim())) errors.push('adapter areas must be non-empty strings');
  return errors;
}

export function validateIssueMetadata(metadata, areas = []) {
  if (metadata.Area && !areas.includes(metadata.Area)) throw new Error(`Area not allowed by adapter: ${metadata.Area}`);
  return metadata;
}

export function planUpdates(metadata, fields, current = {}) {
  const updates = [];
  for (const [name, value] of Object.entries(metadata)) {
    const field = fields[name];
    if (!field || current[name] === value) continue;
    if (field.options) {
      const option = field.options.find(entry => entry.name === value);
      if (!option) throw new Error(`unknown ${name} option: ${value}`);
      updates.push({ fieldId: field.id, kind: 'singleSelectOptionId', value: option.id, name, display: value });
    } else updates.push({ fieldId: field.id, kind: name.includes('Date') ? 'date' : 'text', value, name, display: value });
  }
  return updates;
}

function paginatedPath(path, page, perPage) {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('per_page', String(perPage));
  params.set('page', String(page));
  return `${pathname}?${params.toString()}`;
}

export async function paginateRest(client, path, options = {}) {
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 1000;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error('pagination perPage must be an integer from 1 to 100');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('pagination maxPages must be a positive integer');

  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await client.rest(paginatedPath(path, page, perPage));
    if (!Array.isArray(batch)) throw new Error(`GitHub pagination expected an array for ${path}`);
    items.push(...batch);
    if (batch.length < perPage) return items;
  }
  throw new Error(`GitHub pagination exceeded ${maxPages} pages for ${path}`);
}

export async function listRepositoryIssues(client, issueNumber = 0) {
  if (issueNumber) return [await client.rest(`/issues/${issueNumber}`)];
  const items = await paginateRest(client, '/issues?state=all');
  return items.filter(item => !item.pull_request);
}

export function listRepositoryBranches(client) {
  return paginateRest(client, '/branches');
}

class GitHub {
  constructor(token, repository) { this.token = token; [this.owner, this.repo] = repository.split('/'); }
  async request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...options.headers } });
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
    return response.json();
  }
  rest(path) { return this.request(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`); }
  async graphql(query, variables) {
    const result = await this.request('https://api.github.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (result.errors) throw new Error(result.errors.map(error => error.message).join('; '));
    return result.data;
  }
}

async function projectContext(client, adapter) {
  const ownerField = adapter.project.ownerType === 'organization' ? 'organization' : 'user';
  const query = `query($login:String!,$number:Int!){${ownerField}(login:$login){projectV2(number:$number){id fields(first:50){nodes{... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`;
  const data = await client.graphql(query, { login: adapter.project.owner, number: adapter.project.number });
  const project = data[ownerField]?.projectV2;
  if (!project) throw new Error('configured Project not found');
  return { id: project.id, fields: Object.fromEntries(project.fields.nodes.filter(Boolean).map(field => [field.name, field])) };
}

async function ensureItem(client, projectId, contentId) {
  const mutation = `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`;
  return (await client.graphql(mutation, { project: projectId, content: contentId })).addProjectV2ItemById.item.id;
}

async function applyUpdate(client, projectId, itemId, update) {
  const value = { [update.kind]: update.value };
  const mutation = `mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}`;
  await client.graphql(mutation, { project: projectId, item: itemId, field: update.fieldId, value });
}

async function syncIssue(client, context, adapter, issue, dryRun, getBranches) {
  const planned = extract(issue.body, 'Planned branch');
  const pulls = planned ? await client.rest(`/pulls?state=all&per_page=100&head=${encodeURIComponent(`${client.owner}:${planned}`)}`) : [];
  const pr = pulls[0];
  let branch;
  if (planned && pr) branch = planned;
  else if (planned && (await getBranches()).some(entry => entry.name === planned)) branch = planned;
  const startDate = pr?.created_at?.slice(0, 10) ?? (branch ? issue.created_at?.slice(0, 10) : undefined);
  const metadata = validateIssueMetadata(deriveIssueMetadata(issue, { project: adapter.project.displayName, branch, startDate, reviewReady: Boolean(pr?.draft === false && !pr?.merged_at), merged: Boolean(pr?.merged_at) }), adapter.areas);
  const updates = planUpdates(metadata, context.fields);
  if (dryRun) return { issue: issue.number, metadata, updates };
  const itemId = await ensureItem(client, context.id, issue.node_id);
  for (const update of updates) await applyUpdate(client, context.id, itemId, update);
  return { issue: issue.number, metadata, updates: updates.map(update => update.name) };
}

export async function syncIssues(client, context, adapter, issues, getBranches, dryRun = false) {
  const results = [];
  for (const issue of issues) results.push(await syncIssue(client, context, adapter, issue, dryRun, getBranches));
  return results;
}

async function main() {
  const adapter = JSON.parse(await readFile(process.env.DEVOPS_ADAPTER ?? '.development-operations.yml', 'utf8'));
  const token = process.env.DEVOPS_PROJECT_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY ?? adapter.project.repository;
  if (!token) throw new Error('DEVOPS_PROJECT_TOKEN is required');
  const client = new GitHub(token, repository);
  const context = await projectContext(client, adapter);
  const errors = validateProjectSchema(context.fields, adapter.areas);
  if (errors.length) throw new Error(errors.join('; '));
  const issueNumber = Number(process.env.DEVOPS_ISSUE_NUMBER || 0);
  const issues = await listRepositoryIssues(client, issueNumber);
  let branchesPromise;
  const getBranches = () => branchesPromise ??= listRepositoryBranches(client);
  const results = await syncIssues(client, context, adapter, issues, getBranches, process.argv.includes('--dry-run'));
  console.log(JSON.stringify(results, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
