import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { resolve } from 'node:path';

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return false;
  const normalized = normalize(value);
  return normalized !== '.' && !normalized.startsWith('..');
}

export function validateAdapter(value) {
  const errors = [];
  const required = ['standardsVersion', 'project', 'areas', 'platforms', 'commands', 'policyReferences', 'security', 'overrides'];
  for (const key of required) if (!(key in value)) errors.push(`missing ${key}`);
  if (value.standardsVersion !== '0.2.0') errors.push('standardsVersion must be 0.2.0');
  const project = value.project ?? {};
  for (const key of ['displayName', 'repository', 'owner', 'ownerType', 'number']) if (!(key in project)) errors.push(`missing project.${key}`);
  if (project.ownerType && !['user', 'organization'].includes(project.ownerType)) errors.push('project.ownerType must be user or organization');
  if (project.repository && !/^[^/]+\/[^/]+$/.test(project.repository)) errors.push('project.repository must be owner/name');
  if (project.number !== undefined && (!Number.isInteger(project.number) || project.number < 1)) errors.push('project.number must be a positive integer');
  if (!Array.isArray(value.areas) || value.areas.length === 0) errors.push('areas must contain at least one value');
  if (value.areas && new Set(value.areas).size !== value.areas.length) errors.push('areas must be unique');
  const preserved = value.inheritance?.preserve ?? [];
  if (!Array.isArray(preserved) || preserved.some(entry => !safeRelativePath(entry))) errors.push('inheritance.preserve must contain safe relative paths');
  if (new Set(preserved).size !== preserved.length) errors.push('inheritance.preserve paths must be unique');
  const serialized = JSON.stringify(value);
  if (/SWAYFORGE_|ONESTEP_|token|secretValue/i.test(serialized)) errors.push('adapter contains project-specific variable or secret-like key');
  return errors;
}

async function main() {
  const filename = resolve(process.argv[2] ?? '.development-operations.yml');
  let value;
  try { value = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { console.error(`Invalid JSON-compatible YAML: ${error.message}`); process.exitCode = 1; return; }
  const errors = validateAdapter(value);
  if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; return; }
  console.log(`Valid adapter: ${filename}`);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\\\', '/')}`).href) main();
