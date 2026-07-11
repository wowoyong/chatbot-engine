export class LlmConnectionError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `Ollama 서버(${baseUrl})에 연결할 수 없습니다. 'ollama serve' 실행 여부를 확인하세요.`,
      { cause },
    );
    this.name = 'LlmConnectionError';
  }
}

export class LlmResponseError extends Error {
  readonly status: number;

  /** status 0 = 스트림 내부 오류 (HTTP 레벨은 200이었으나 본문에 error 라인) */
  constructor(status: number, detail: string) {
    super(`Ollama 응답 오류(status ${status}): ${detail}`);
    this.name = 'LlmResponseError';
    this.status = status;
  }
}
