export type KnowledgeStatus = 'draft' | 'verified' | 'deprecated';

export interface DocumentMetadata {
  type?: string;
  title?: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
  status?: KnowledgeStatus;
  category?: string;
  provenance?: string;
  reviewedAt?: string;
}

export interface MarkdownDocument {
  metadata: DocumentMetadata | null;
  body: string;
}

export const MAX_FRONTMATTER_CHARS = 64 * 1024;

function parseQuotedScalar(raw: string): string {
  if (raw.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OKF frontmatter의 double-quoted 값이 올바르지 않습니다');
    }
    if (typeof parsed !== 'string') {
      throw new Error('OKF frontmatter scalar는 문자열이어야 합니다');
    }
    return parsed;
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new Error('OKF frontmatter의 single-quoted 값이 닫히지 않았습니다');
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function splitFlowList(inner: string): string[] {
  const values: string[] = [];
  let buffer = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of inner) {
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      buffer += char;
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote === null) quote = char;
      else if (quote === char) quote = null;
      buffer += char;
      continue;
    }
    if (char === ',' && quote === null) {
      values.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
  }
  if (quote !== null) {
    throw new Error('OKF frontmatter flow-list의 quote가 닫히지 않았습니다');
  }
  if (buffer.trim().length > 0) values.push(buffer.trim());
  return values;
}

function parseTags(raw: string): string[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    throw new Error('OKF tags는 flow-list 형식이어야 합니다');
  }
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return splitFlowList(inner)
    .map(parseQuotedScalar)
    .filter((tag) => tag.length > 0);
}

function parseStatus(raw: string): KnowledgeStatus {
  const status = parseQuotedScalar(raw);
  if (status === 'draft' || status === 'verified' || status === 'deprecated') {
    return status;
  }
  throw new Error(`지원하지 않는 knowledge status입니다: ${status}`);
}

function setScalar(metadata: DocumentMetadata, key: string, raw: string): void {
  const value = parseQuotedScalar(raw);
  if (value.length === 0) return;
  if (key === 'type') metadata.type = value;
  else if (key === 'title') metadata.title = value;
  else if (key === 'description') metadata.description = value;
  else if (key === 'resource') metadata.resource = value;
  else if (key === 'timestamp') metadata.timestamp = value;
  else if (key === 'category') metadata.category = value;
  else if (key === 'provenance') metadata.provenance = value;
  else if (key === 'reviewed_at') metadata.reviewedAt = value;
}

export function parseMarkdownDocument(markdown: string): MarkdownDocument {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return { metadata: null, body: normalized };

  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) {
    throw new Error('OKF frontmatter closing delimiter가 없습니다');
  }
  const frontmatter = lines.slice(1, closing).join('\n');
  if (frontmatter.length > MAX_FRONTMATTER_CHARS) {
    throw new Error(`OKF frontmatter가 ${MAX_FRONTMATTER_CHARS}자를 초과했습니다`);
  }

  const metadata: DocumentMetadata = { tags: [] };
  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match === null) {
      throw new Error(`지원하지 않는 OKF frontmatter 줄입니다: ${trimmed}`);
    }
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) {
      throw new Error(`OKF frontmatter key/value를 읽지 못했습니다: ${trimmed}`);
    }
    if (key === 'tags') metadata.tags = parseTags(raw);
    else if (key === 'status') metadata.status = parseStatus(raw);
    else setScalar(metadata, key, raw);
  }
  const bodyLines = lines.slice(closing + 1);
  if (bodyLines[0] === '') bodyLines.shift();
  return { metadata, body: bodyLines.join('\n') };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function serializeMarkdownDocument(
  metadata: DocumentMetadata & { type: string },
  body: string,
): string {
  if (metadata.type.trim().length === 0) {
    throw new Error('OKF metadata type은 비어있을 수 없습니다');
  }
  const lines = ['---', `type: ${yamlString(metadata.type)}`];
  if (metadata.title !== undefined) lines.push(`title: ${yamlString(metadata.title)}`);
  if (metadata.description !== undefined) lines.push(`description: ${yamlString(metadata.description)}`);
  if (metadata.resource !== undefined) lines.push(`resource: ${yamlString(metadata.resource)}`);
  if (metadata.tags.length > 0) lines.push(`tags: ${JSON.stringify(metadata.tags)}`);
  if (metadata.timestamp !== undefined) lines.push(`timestamp: ${yamlString(metadata.timestamp)}`);
  if (metadata.status !== undefined) lines.push(`status: ${metadata.status}`);
  if (metadata.category !== undefined) lines.push(`category: ${yamlString(metadata.category)}`);
  if (metadata.provenance !== undefined) lines.push(`provenance: ${yamlString(metadata.provenance)}`);
  if (metadata.reviewedAt !== undefined) lines.push(`reviewed_at: ${yamlString(metadata.reviewedAt)}`);
  lines.push('---', '', body.replace(/^\n+/, '').replace(/\n+$/, ''), '');
  return lines.join('\n');
}
