import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const centralRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }

export function resolveManagedPath(root, entry) {
  if (typeof entry !== 'string' || !entry || isAbsolute(entry)) throw new Error(`Unsafe managed inheritance path: ${entry}`);
  const resolvedRoot = resolve(root); const candidate = resolve(resolvedRoot, entry); const remainder = relative(resolvedRoot, candidate);
  if (!remainder || /^\.\.(?:[\\/]|$)/.test(remainder) || isAbsolute(remainder)) throw new Error(`Unsafe managed inheritance path: ${entry}`);
  return candidate;
}

export async function syncInheritance(targetRoot, { write = false } = {}) {
  const resolvedTarget = resolve(targetRoot);
  const manifest = await readJson(resolveManagedPath(centralRoot, 'inheritance/manifest.json'));
  const adapter = await readJson(resolveManagedPath(resolvedTarget, '.development-operations.yml'), {});
  const preserved = [...new Set([...(manifest.preserved ?? []), ...(adapter.inheritance?.preserve ?? [])])];
  const preservedSet = new Set(preserved);
  const statePath = resolveManagedPath(resolvedTarget, '.development-operations/managed-state.json');
  const previous = await readJson(statePath, { standardsVersion: null, files: {} });
  const next = { standardsVersion: manifest.standardsVersion, files: {} };
  const changes = [], conflicts = [];
  for (const entry of manifest.managed) {
    if (preservedSet.has(entry)) continue;
    const source = await readFile(resolveManagedPath(centralRoot, entry));
    const sourceHash = hash(source);
    const destination = resolveManagedPath(resolvedTarget, entry);
    let current;
    try { current = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const currentHash = current && hash(current);
    if (current && currentHash !== sourceHash && currentHash !== previous.files[entry]) conflicts.push(entry);
    else if (currentHash !== sourceHash) {
      changes.push(entry);
      if (write) { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, source); }
    }
    next.files[entry] = sourceHash;
  }
  if (write && !conflicts.length) { await mkdir(dirname(statePath), { recursive: true }); await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`); }
  return { standardsVersion: manifest.standardsVersion, changes, conflicts, preserved };
}

async function main() {
  const target = resolve(process.argv[2] ?? '.');
  const write = process.argv.includes('--write');
  const result = await syncInheritance(target, { write });
  console.log(JSON.stringify(result, null, 2));
  if (result.conflicts.length || (!write && result.changes.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\\\', '/')}`).href) main();
