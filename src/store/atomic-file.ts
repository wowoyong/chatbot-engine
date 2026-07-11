import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 원자적 파일 쓰기: 디렉토리 생성 → `<파일>.tmp`에 기록 → rename */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}
