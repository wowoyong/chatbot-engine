import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { ChatSession } from '../chat/session.js';
import { LlmConnectionError } from '../llm/errors.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { SessionStore } from '../store/session-store.js';

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
const DEFAULT_SESSION_FILE = '.chatbot/session.json';

async function main(): Promise<void> {
  const client = new OllamaClient({
    baseUrl: env['OLLAMA_BASE_URL'],
    model: env['OLLAMA_MODEL'],
  });
  const session = new ChatSession(client, { systemPrompt: SYSTEM_PROMPT });
  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );

  const restored = await store.load();
  if (restored !== null && restored.length > 0) {
    session.restore(restored);
    stdout.write(
      `(이전 세션을 복원했습니다 — ${Math.floor(restored.length / 2)}턴)\n`,
    );
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\n');
    exit(0);
  });

  stdout.write(
    `chatbot-engine — ${env['OLLAMA_MODEL'] ?? 'qwen3:8b'} (명령: /exit 종료, /clear 히스토리 초기화)\n`,
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
      session.clear();
      await store.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }

    stdout.write('bot> ');
    try {
      for await (const piece of session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
      await store.save(session.getHistory());
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
