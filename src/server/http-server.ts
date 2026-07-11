import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../app/bootstrap.js';

export interface ChatServerConfig {
  app: App;
  /** 정적 UI 파일 경로. 기본: 이 파일 기준 ./public/index.html */
  indexHtmlPath?: string;
}

const MAX_BODY_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('요청 본문이 너무 큽니다');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createChatServer(config: ChatServerConfig): Server {
  const { app } = config;
  const htmlPath =
    config.indexHtmlPath ??
    join(dirname(fileURLToPath(import.meta.url)), 'public', 'index.html');
  let chatting = false;

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (chatting) {
      sendJson(res, 409, { error: '이미 응답을 생성 중입니다. 잠시 후 다시 시도하세요.' });
      return;
    }
    let message: string;
    try {
      const parsed: unknown = JSON.parse(await readBody(req));
      if (
        !isRecord(parsed) ||
        typeof parsed['message'] !== 'string' ||
        parsed['message'].trim().length === 0
      ) {
        sendJson(res, 400, { error: 'message(비어있지 않은 문자열)가 필요합니다' });
        return;
      }
      message = parsed['message'].trim();
    } catch {
      sendJson(res, 400, { error: '잘못된 JSON 본문' });
      return;
    }

    chatting = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      for await (const piece of app.session.send(message)) {
        if (res.destroyed) {
          return; // 클라이언트 중단 — 제너레이터 조기 종료로 히스토리 미기록
        }
        res.write(`data: ${JSON.stringify({ piece })}\n\n`);
      }
      await app.store.save(app.session.getHistory());
      res.write('event: done\ndata: {}\n\n');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: detail })}\n\n`);
    } finally {
      chatting = false;
      res.end();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    if (route === 'GET /') {
      let html: string;
      try {
        html = await readFile(htmlPath, 'utf8');
      } catch {
        sendJson(res, 404, { error: 'UI 파일이 없습니다' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (route === 'GET /api/history') {
      sendJson(res, 200, { history: app.session.getHistory() });
      return;
    }
    if (route === 'POST /api/clear') {
      app.session.clear();
      await app.store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (route === 'POST /api/index') {
      const chunks = await app.rebuildIndex(new Date().toISOString());
      sendJson(res, 200, { chunks });
      return;
    }
    if (route === 'POST /api/capture') {
      const result = await app.captureKnowledge(new Date().toISOString());
      sendJson(res, 200, result);
      return;
    }
    if (route === 'POST /api/chat') {
      await handleChat(req, res);
      return;
    }
    sendJson(res, 404, { error: `알 수 없는 경로: ${route}` });
  }

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: detail });
      } else {
        res.end();
      }
    });
  });
}
