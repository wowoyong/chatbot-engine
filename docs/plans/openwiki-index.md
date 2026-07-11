# openwiki — Segment 4 실행 계획 (운영형)

Baseline: main@b29d643 (clean)

## 개요

Segment 4 — OpenWiki(`openwiki@0.1.1`, DeepAgents 기반)로 엔진 레포를 자동 문서화하고, 산출물을 별도 레포 `chatbot-engine-wiki`로 분리한 뒤, Segment 3의 RAG(`RAG_DOCS_DIR`)로 챗봇이 자기 wiki를 습득하게 한다.

> **rtb:plan 형식 예외 (사유 명시)**: 본 segment는 Haiku가 복사할 코드 블록이 아니라 **외부 대화형 CLI 운영 작업**(에이전트 실행·모니터링·품질 판정)이 중심이므로, Phase별 완전 코드 문서 대신 명령·판정 기준·fallback을 기록하는 운영 계획으로 대체한다. 실행은 메인 세션이 직접 수행.

## 확정 결정 (사용자 승인)

| 항목 | 결정 |
|------|------|
| 생성 모델 | **qwen3:8b 로컬** (openai-compatible provider → `localhost:11434/v1`). 실패 시 fallback: qwen3:14b → 클라우드(OpenRouter) 순으로 사용자 재확인 |
| 산출물 취급 | 엔진 레포의 `openwiki/`는 **gitignore** — wiki의 단일 진실 소스는 별도 레포 `../chatbot-engine-wiki` |
| 자동 갱신 | GitHub Actions는 Out-of-Scope (GitHub remote 없음) — 로컬 `openwiki code --update` + sync 재실행으로 갈음 |

## 실행 환경 (소스 분석으로 확인)

```bash
export OPENWIKI_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
export OPENAI_COMPATIBLE_API_KEY=ollama          # Ollama는 키 검증 안 함 — 형식용
export OPENWIKI_MODEL_ID=qwen3:8b
npx -y openwiki code --init
```

- 산출 위치: 레포 내 `openwiki/` (`OPEN_WIki_DIR` 상수 확인)
- `AGENTS.md`에 스니펫 마커(`OPENWIKI_AGENTS_SNIPPET_START/END`)로 wiki 참조 자동 삽입

## Phase

| Phase | 작업 | 판정 기준 (AC) |
|-------|------|---------------|
| 0 | `openwiki code --init` 실행 (백그라운드 + 진행 모니터링) | `openwiki/`에 md 문서 생성됨, 내용이 실제 코드 구조와 부합 (LlmClient/ChatSession/RAG 언급), AGENTS.md 스니펫 삽입 |
| 1 | `../chatbot-engine-wiki` git 레포 생성 + sync 스크립트(`npm run sync-wiki`) + 엔진 레포 `.gitignore`에 `openwiki/` 추가 | wiki 레포에 문서 커밋됨, sync 재실행 멱등 |
| 2 | `RAG_DOCS_DIR=../chatbot-engine-wiki npm run dev` → `/index` → 자기참조 질문 검증 | "너는 어떻게 동작해?" 류 질문에 wiki 발췌 근거(출처 인용)로 답변 |

## 리스크와 fallback

| # | 위험 | 판정·대응 |
|---|-----|----------|
| R1 | 8B가 DeepAgents 도구 호출을 감당 못 함 (루프/오류/빈 산출) | 진행 로그에서 도구 호출 실패 반복 or 30분+ 무산출 시 중단 → 14b 재시도 제안 (사용자 확인 후) |
| R2 | 장시간 실행 | 백그라운드 실행 + 주기 확인, 산출은 증분(파일 단위)이므로 부분 산출도 평가 가능 |
| R3 | 대화형 REPL 대기 (init 후 프롬프트) | 산출 완료 확인 후 프로세스 종료 — 파일은 이미 디스크에 존재 |

## Rollback

- `openwiki/` 삭제 + `.gitignore` 항목 제거 + AGENTS.md 스니펫 블록 제거 + wiki 레포 삭제 — 엔진 코드 무접촉이므로 완전 가역
