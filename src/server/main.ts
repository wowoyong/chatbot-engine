import { env, exit } from 'node:process';
import { createApp } from '../app/bootstrap.js';
import { createChatServer } from './http-server.js';

async function main(): Promise<void> {
  const host = env['HOST'] ?? '127.0.0.1';
  const port = Number(env['PORT'] ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`잘못된 PORT: ${env['PORT']}`);
    exit(1);
  }

  const app = await createApp(env);
  for (const notice of app.startupNotices) {
    console.log(`(${notice})`);
  }

  const server = createChatServer({ app });
  server.listen(port, host, () => {
    console.log(
      `chatbot-engine 웹 서버 (${app.modelName}): http://${host}:${port}`,
    );
  });

  process.on('SIGINT', () => {
    server.close();
    exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
