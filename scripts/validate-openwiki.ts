import { access, readFile, readdir } from 'node:fs/promises';
import { argv } from 'node:process';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdownDocument } from '../src/okf/document.js';

export interface ValidationIssue {
  file: string;
  message: string;
}

export const REQUIRED_OPENWIKI_PATHS = [
  'index.md',
  'quickstart.md',
  'architecture/overview.md',
  'architecture/request-flow.md',
  'components/native-inference.md',
  'components/rag.md',
  'components/knowledge-capture.md',
  'interfaces/cli-and-http.md',
  'operations/openwiki-and-deployment.md',
  'testing/evaluation.md',
  'reference/configuration.md',
  'source-map.md',
  'log.md',
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(path)));
    else if (entry.isFile() && extname(entry.name) === '.md') files.push(path);
  }
  return files;
}

function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.';
}

async function validateRequiredFiles(root: string, issues: ValidationIssue[]): Promise<void> {
  for (const required of REQUIRED_OPENWIKI_PATHS) {
    if (!(await pathExists(join(root, required)))) {
      issues.push({ file: required, message: 'required OpenWiki page is missing' });
    }
  }
}

async function validateOkfMetadata(
  root: string,
  files: readonly string[],
  issues: ValidationIssue[],
): Promise<void> {
  for (const file of files) {
    const name = displayPath(root, file);
    const source = await readFile(file, 'utf8');
    if (name === 'index.md') {
      if (!/^okf_version:\s*["']?0\.1["']?\s*$/m.test(source)) {
        issues.push({ file: name, message: 'root index must declare okf_version: 0.1' });
      }
      continue;
    }
    if (name === 'log.md' || name === 'INSTRUCTIONS.md') continue;
    try {
      const parsed = parseMarkdownDocument(source);
      if (parsed.metadata?.type?.trim().length === 0 || parsed.metadata?.type === undefined) {
        issues.push({ file: name, message: 'OKF metadata type is missing' });
      }
    } catch (error) {
      issues.push({
        file: name,
        message: `invalid OKF metadata: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

function stripTargetSuffix(target: string): string {
  return target.split('#', 1)[0]?.split('?', 1)[0] ?? '';
}

async function validateInternalLinks(
  root: string,
  files: readonly string[],
  issues: ValidationIssue[],
): Promise<void> {
  const rootPrefix = resolve(root) + sep;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of source.matchAll(linkPattern)) {
      const raw = match[1]?.trim().replace(/^<|>$/g, '');
      if (raw === undefined || raw.length === 0 || /^(https?:|mailto:)/i.test(raw)) continue;
      let target: string;
      try {
        target = decodeURIComponent(stripTargetSuffix(raw));
      } catch {
        issues.push({ file: displayPath(root, file), message: `invalid link encoding: ${raw}` });
        continue;
      }
      if (target.length === 0) continue;
      const rootRelative = target.startsWith('/openwiki/')
        ? target.slice('/openwiki/'.length)
        : target.startsWith('/')
          ? target.slice(1)
          : null;
      let resolved = rootRelative === null ? resolve(dirname(file), target) : resolve(root, rootRelative);
      if (resolved !== resolve(root) && !resolved.startsWith(rootPrefix)) {
        issues.push({ file: displayPath(root, file), message: `link escapes OpenWiki root: ${raw}` });
        continue;
      }
      if (extname(resolved) === '') resolved = join(resolved, 'index.md');
      if (!(await pathExists(resolved))) {
        issues.push({ file: displayPath(root, file), message: `broken link target: ${raw}` });
      }
    }
  }
}

async function validateDocumentedCommands(
  repoRoot: string,
  openwikiRoot: string,
  files: readonly string[],
  issues: ValidationIssue[],
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};
  for (const file of files) {
    if (displayPath(openwikiRoot, file) === 'INSTRUCTIONS.md') continue;
    const source = await readFile(file, 'utf8');
    const snippets = [...source.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]?.trim() ?? '');
    for (const block of source.matchAll(/```(?:bash|sh|shell|zsh|console)\s*\n([\s\S]*?)```/gi)) {
      for (const line of (block[1] ?? '').split('\n')) {
        const command = line.trim().replace(/^\$\s+/, '');
        if (command.length > 0 && !command.startsWith('#')) snippets.push(command);
      }
    }
    for (const command of snippets) {
      const run = command.match(/^npm run ([A-Za-z0-9:_-]+)(?:\s|$)/);
      if (run !== null) {
        const name = run[1];
        if (name !== undefined && scripts[name] === undefined) {
          issues.push({ file: displayPath(openwikiRoot, file), message: `stale command: npm run ${name}` });
        }
        continue;
      }
      const lifecycle = command.match(/^npm (start|test|stop|restart)(?:\s|$)/);
      if (lifecycle !== null) {
        const name = lifecycle[1];
        if (name !== undefined && scripts[name] === undefined) {
          issues.push({ file: displayPath(openwikiRoot, file), message: `stale command: npm ${name}` });
        }
        continue;
      }
      if (/^npm (install|ci)(?:\s|$)/.test(command)) continue;
      if (/^npx -y openwiki@0\.2\.1(?:\s|$)/.test(command)) continue;
      if (/^npx .*openwiki/.test(command)) {
        issues.push({ file: displayPath(openwikiRoot, file), message: `OpenWiki command must pin 0.2.1: ${command}` });
        continue;
      }
      const local = command.match(/^(node|tsx|bash)\s+([^\s]+)(?:\s|$)/);
      if (local !== null) {
        const path = local[2]?.replace(/^['"]|['"]$/g, '');
        if (path !== undefined && !isAbsolute(path) && !(await pathExists(resolve(repoRoot, path)))) {
          issues.push({ file: displayPath(openwikiRoot, file), message: `stale local command path: ${path}` });
        }
      }
    }
  }
}

export async function validateOpenWiki(
  openwikiRoot: string,
  repoRoot = resolve(openwikiRoot, '..'),
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  await validateRequiredFiles(openwikiRoot, issues);
  const markdownFiles = await listMarkdownFiles(openwikiRoot);
  await validateOkfMetadata(openwikiRoot, markdownFiles, issues);
  await validateInternalLinks(openwikiRoot, markdownFiles, issues);
  await validateDocumentedCommands(repoRoot, openwikiRoot, markdownFiles, issues);
  return issues;
}

async function main(): Promise<void> {
  const issues = await validateOpenWiki(resolve(process.cwd(), 'openwiki'));
  for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);
  if (issues.length > 0) process.exitCode = 1;
}

if (argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
