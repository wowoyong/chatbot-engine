import { link, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { DocumentMetadata, KnowledgeStatus } from '../okf/document.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../okf/document.js';
import { writeFileAtomic } from '../store/atomic-file.js';
import { KNOWLEDGE_CATEGORIES } from './extractor.js';
import type { NoveltyVerdict } from './novelty.js';

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'knowledge';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function writeFileExclusiveAtomic(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });
  }
}

async function acquireApprovalLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.approve.lock`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new CapturedApprovalError('NOT_DRAFT', 'captured entry approval is already in progress');
    }
    throw error;
  }
  return async () => {
    await handle.close();
    await unlink(lockPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });
  };
}

async function readCapturedSource(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CapturedApprovalError('NOT_FOUND', 'captured entry not found');
    }
    throw error;
  }
}

async function ensureExclusiveCapturedPath(
  dir: string,
  base: string,
  content: string,
): Promise<string> {
  let suffix = 1;
  while (true) {
    const path = join(dir, suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`);
    if (await writeFileExclusiveAtomic(path, content)) return path;
    suffix += 1;
  }
}

function firstMarkdownHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export interface CapturedEntry {
  id: string;
  title: string;
  category: string;
  status: KnowledgeStatus;
}

export type CapturedApprovalErrorCode = 'INVALID_ID' | 'NOT_FOUND' | 'NOT_DRAFT';

export class CapturedApprovalError extends Error {
  constructor(
    readonly code: CapturedApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapturedApprovalError';
  }
}

async function resolveCapturedId(baseDir: string, id: string): Promise<string> {
  if (id.length === 0 || isAbsolute(id) || extname(id) !== '.md') {
    throw new CapturedApprovalError('INVALID_ID', 'invalid captured id');
  }
  const normalized = normalize(id).replaceAll('\\', '/');
  const parts = id.split('/');
  if (
    normalized !== id ||
    parts.length !== 2 ||
    !(KNOWLEDGE_CATEGORIES as readonly string[]).includes(parts[0] ?? '')
  ) {
    throw new CapturedApprovalError('INVALID_ID', 'invalid captured id');
  }
  const base = resolve(baseDir);
  const candidate = resolve(base, id);
  if (!candidate.startsWith(base + sep)) {
    throw new CapturedApprovalError('INVALID_ID', 'invalid captured id');
  }
  try {
    const [realBase, realCandidate] = await Promise.all([realpath(base), realpath(candidate)]);
    if (!realCandidate.startsWith(realBase + sep)) {
      throw new CapturedApprovalError('INVALID_ID', 'captured id escapes base directory');
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof CapturedApprovalError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CapturedApprovalError('NOT_FOUND', 'captured entry not found');
    }
    throw error;
  }
}

export async function saveCaptured(
  baseDir: string,
  verdict: NoveltyVerdict,
  capturedAt: string,
): Promise<string> {
  const dir = join(baseDir, verdict.candidate.category);
  const base = slugify(verdict.candidate.title);
  const metadata: DocumentMetadata & { type: string } = {
    type: 'Captured Knowledge',
    title: verdict.candidate.title,
    description: verdict.candidate.content.replaceAll(/\s+/g, ' ').trim().slice(0, 160),
    tags: ['captured', verdict.candidate.category],
    timestamp: capturedAt,
    status: 'draft',
    category: verdict.candidate.category,
    provenance: 'conversation',
  };
  const body = [
    `# ${verdict.candidate.title}`,
    '',
    verdict.candidate.content,
    '',
    `> novelty: ${verdict.maxScore.toFixed(3)}`,
  ].join('\n');
  return ensureExclusiveCapturedPath(dir, base, serializeMarkdownDocument(metadata, body));
}

export async function listCaptured(baseDir: string): Promise<CapturedEntry[]> {
  const entries: CapturedEntry[] = [];
  for (const category of KNOWLEDGE_CATEGORIES) {
    const dir = join(baseDir, category);
    let files: string[];
    try {
      files = (await readdir(dir))
        .filter((file) => file.endsWith('.md'))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      const parsed = parseMarkdownDocument(source);
      entries.push({
        id: `${category}/${file}`,
        title: parsed.metadata?.title ?? firstMarkdownHeading(parsed.body) ?? basename(file, '.md'),
        category,
        status: parsed.metadata?.status ?? 'verified',
      });
    }
  }
  return entries;
}

export async function approveCaptured(
  baseDir: string,
  id: string,
  reviewedAt: string,
): Promise<CapturedEntry> {
  const path = await resolveCapturedId(baseDir, id);
  const release = await acquireApprovalLock(path);
  try {
    const source = await readCapturedSource(path);
    const parsed = parseMarkdownDocument(source);
    const current = parsed.metadata;
    if (current?.status !== 'draft') {
      throw new CapturedApprovalError('NOT_DRAFT', 'captured entry is not draft');
    }
    const type = current.type?.trim();
    const title = current.title?.trim();
    if (!type || !title) {
      throw new CapturedApprovalError('NOT_DRAFT', 'captured draft metadata is incomplete');
    }
    const metadata: DocumentMetadata & { type: string; title: string } = {
      ...current,
      type,
      title,
      status: 'verified',
      reviewedAt,
    };
    await writeFileAtomic(path, serializeMarkdownDocument(metadata, parsed.body));
    return {
      id,
      title,
      category: metadata.category ?? id.split('/')[0] ?? 'concept',
      status: 'verified',
    };
  } finally {
    await release();
  }
}
