import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PAGE_FILES = Object.freeze([
  ['demo/index.html', 'index.html'],
  ['styles.css', 'styles.css'],
  ['demo/demo.css', 'demo/demo.css'],
  ['demo/demo-app.js', 'demo/demo-app.js'],
  ['demo/demo-bootstrap.js', 'demo/demo-bootstrap.js'],
  ['demo/demo-data.js', 'demo/demo-data.js'],
  ['demo/demo-state.js', 'demo/demo-state.js'],
  ['assets/onestep-money-icon.png', 'assets/onestep-money-icon.png'],
  ['automation-review-integration.js', 'automation-review-integration.js'],
  ['automation-rule-model.js', 'automation-rule-model.js'],
  ['automation-rules-ui.js', 'automation-rules-ui.js'],
  ['automation-state.js', 'automation-state.js'],
  ['date-utils.js', 'date-utils.js'],
  ['finance-core.js', 'finance-core.js'],
  ['financial-reminders.js', 'financial-reminders.js'],
  ['financial-reminders-ui.js', 'financial-reminders-ui.js'],
  ['financial-reporting.js', 'financial-reporting.js'],
  ['next-move-priority.js', 'next-move-priority.js'],
  ['payday-awareness.js', 'payday-awareness.js'],
  ['payday-awareness-ui.js', 'payday-awareness-ui.js'],
  ['presentation-settings.js', 'presentation-settings.js'],
  ['recurring-finance.js', 'recurring-finance.js'],
  ['recurring-finance-ui.js', 'recurring-finance-ui.js'],
  ['review-lifecycle-base.js', 'review-lifecycle-base.js'],
  ['review-lifecycle.js', 'review-lifecycle.js'],
  ['transaction-categorisation.js', 'transaction-categorisation.js'],
  ['unified-financial-profile.js', 'unified-financial-profile.js']
]);

export async function buildPagesSite(options = {}) {
  const root = path.resolve(options.root || repositoryRoot);
  const output = path.resolve(options.output || path.join(root, 'dist', 'pages'));
  if (output === root || output === path.parse(output).root) {
    throw new Error('Refusing to replace a broad Pages output path.');
  }

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });

  for (const [sourcePath, publicPath] of PAGE_FILES) {
    const source = path.join(root, sourcePath);
    const target = path.join(output, publicPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  await fs.writeFile(path.join(output, '.nojekyll'), '');

  await validatePagesSite(output);
  return { output, files: PAGE_FILES.map(([, publicPath]) => publicPath) };
}

async function validatePagesSite(output) {
  const html = await fs.readFile(path.join(output, 'index.html'), 'utf8');
  const resourcePaths = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith('#'));
  for (const resourcePath of resourcePaths) {
    if (resourcePath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(resourcePath)) {
      throw new Error(`Pages resource must be project-relative: ${resourcePath}`);
    }
    await fs.access(path.resolve(output, resourcePath));
  }

  const publicPaths = new Set(PAGE_FILES.map(([, publicPath]) => publicPath));
  for (const [, publicPath] of PAGE_FILES.filter(([, target]) => target.endsWith('.js'))) {
    const source = await fs.readFile(path.join(output, publicPath), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*(?:\(|)\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(publicPath), specifier));
      if (!publicPaths.has(resolved)) throw new Error(`Missing public module ${resolved}, imported by ${publicPath}`);
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  buildPagesSite()
    .then(({ output, files }) => console.log(`Built ${files.length} public demo files in ${output}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
