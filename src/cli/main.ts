import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { createApp } from '../app/bootstrap.js';
import { LlmConnectionError } from '../llm/errors.js';
import type { TurnMeta } from '../chat/session.js';

async function main(): Promise<void> {
  const app = await createApp(env);
  for (const notice of app.startupNotices) {
    stdout.write(`(${notice})\n`);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\n');
    exit(0);
  });

  stdout.write(
    `chatbot-engine — ${app.modelName} (명령: /exit 종료, /clear 히스토리 초기화, /index RAG 인덱스 구축, /capture 지식 저장)\n`,
  );

  while (true) {
    let line: string;
    try {
      line = (await rl.question('you> ')).trim();
    } catch {
      break; // Ctrl-D 등 입력 스트림 종료
    }
    if (line.length === 0) {
      continue;
    }
    if (line === '/exit') {
      break;
    }
    if (line === '/clear') {
      app.session.clear();
      await app.store.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }
    if (line === '/index') {
      try {
        stdout.write(`(${app.docsDir}/ 문서를 인덱싱합니다...)\n`);
        const size = await app.rebuildIndex(new Date().toISOString());
        stdout.write(`(인덱스 구축 완료: ${size}청크 → ${app.indexFile})\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`인덱싱 오류: ${message}\n`);
      }
      continue;
    }
    if (line === '/capture') {
      try {
        stdout.write('(대화에서 지식을 추출합니다...)\n');
        const result = await app.captureKnowledge(new Date().toISOString());
        stdout.write(
          `(추출 ${result.extracted}건 → 저장 ${result.saved.length}건, 기존 지식 ${result.skipped.length}건)\n`,
        );
        for (const path of result.saved) {
          stdout.write(`  + ${path}\n`);
        }
        for (const title of result.skipped) {
          stdout.write(`  = ${title} (이미 알고 있음)\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`지식 추출 오류: ${message} — 다시 시도하세요.\n`);
      }
      continue;
    }

    stdout.write('bot> ');
    try {
      const iterator = app.session.send(line)[Symbol.asyncIterator]();
      let result = await iterator.next();
      while (result.done !== true) {
        stdout.write(result.value);
        result = await iterator.next();
      }
      stdout.write('\n');
      const meta: TurnMeta = result.value;
      if (meta.sources.length > 0) {
        const labels = meta.sources
          .map((s) => (s.heading.length > 0 ? `${s.source} > ${s.heading}` : s.source))
          .join(', ');
        stdout.write(`  출처: ${labels}\n`);
      }
      if (meta.responseTokens !== undefined) {
        stdout.write(
          `  토큰: prompt ${meta.promptTokens ?? '?'} / response ${meta.responseTokens}\n`,
        );
      }
      await app.store.save(app.session.getHistory());
    } catch (err) {
      if (err instanceof LlmConnectionError) {
        stdout.write(`\n오류: ${err.message}\n`);
        rl.close();
        exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(
        `\n오류: ${message} — 히스토리는 보존되었으니 다시 시도하세요.\n`,
      );
    }
  }

  rl.close();
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
