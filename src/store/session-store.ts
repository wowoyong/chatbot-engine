import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatMessage } from '../llm/types.js';

export interface PersistedSession {
  version: 1;
  history: ChatMessage[];
  savedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) {
    return false;
  }
  const role = value['role'];
  const content = value['content'];
  return (
    (role === 'system' || role === 'user' || role === 'assistant') &&
    typeof content === 'string'
  );
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['version'] === 1 &&
    Array.isArray(value['history']) &&
    value['history'].every(isChatMessage) &&
    typeof value['savedAt'] === 'string'
  );
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  /**
   * 저장된 히스토리를 읽는다.
   * - 파일 없음 → null (새 세션)
   * - 손상/스키마 불일치 → `<파일>.bak`으로 보존 후 null (데이터 삭제 안 함)
   */
  async load(): Promise<ChatMessage[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedSession(parsed)) {
        throw new Error('세션 파일 스키마 불일치');
      }
      return parsed.history;
    } catch {
      await rename(this.filePath, `${this.filePath}.bak`);
      return null;
    }
  }

  /** 원자적 저장: `<파일>.tmp`에 쓴 뒤 rename */
  async save(history: readonly ChatMessage[]): Promise<void> {
    const data: PersistedSession = {
      version: 1,
      history: history.map((m) => ({ ...m })),
      savedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
