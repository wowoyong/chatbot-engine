# Knowledge System Reinforcement — Master Implementation Plan

Baseline: main@c4663c2 (clean)

## 개요

OpenWiki 0.2.1이 생성하는 OKF v0.1 문서를 저장소의 canonical knowledge bundle로 만들고, 해당 metadata를 RAG·지식 캡처·평가·CI까지 일관되게 전달한다.

이 작업은 서로 다른 계약을 변경하는 다중 작업이다. `/rtb:plan`의 multi-task 분리 규칙에 따라 아래 5개 segment plan으로 나눈다. 각 segment는 직전 segment가 노출한 인터페이스만 소비하며, 9개 Phase를 순서대로 구현한다.

## Baseline 검증

- branch/SHA: `main@c4663c2`
- working tree: clean
- `npm test`: 179 passed, 7 skipped
- `npm run typecheck`: PASS
- `npm run build`: PASS
- OpenWiki 마지막 생성: `2026-07-11T13:41:16.138Z`, 기준 commit `e277876`
- 현재 HEAD까지 차이: 61 commits
- 현재 OpenWiki Markdown: 7 files
- 현재 OKF frontmatter: 0 files

## Segments

| 순서 | Segment plan | Phase | 책임 |
|---|---|---:|---|
| 1 | `wiki-okf-index.md` | 0~1 | canonical bundle, OpenWiki workflow, 생성 계약 |
| 2 | `okf-indexing-index.md` | 0~1 | OKF parser, metadata index, source fingerprint |
| 3 | `rag-trust-index.md` | 0~1 | scored retrieval, abstention, 안전한 출처 wire |
| 4 | `capture-governance-index.md` | 0~1 | draft/verified lifecycle, 승인 API와 UX |
| 5 | `knowledge-quality-index.md` | 0 | validator, wiki eval, CI와 문서 마감 |

## 실행 순서

`wiki-okf Phase 0 → Phase 1 → okf-indexing Phase 0 → Phase 1 → rag-trust Phase 0 → Phase 1 → capture-governance Phase 0 → Phase 1 → knowledge-quality Phase 0`

병렬 실행하지 않는다. 다음 공유 파일의 시그니처 owner가 segment 순서에 따라 이동하기 때문이다.

## 공유 파일 owner

| 공유 파일 | 최초 owner | 후속 owner | 충돌 방지 규칙 |
|---|---|---|---|
| `src/app/bootstrap.ts` | okf-indexing Phase 1 | rag-trust Phase 0, capture-governance Phase 1 | 각 Phase는 직전 Phase 전체 함수를 baseline으로 사용 |
| `src/rag/vector-index.ts` | okf-indexing Phase 1 | rag-trust Phase 0 | `IndexedChunk.metadata`와 `sourceFingerprint` 제거 금지 |
| `src/rag/hybrid-retriever.ts` | rag-trust Phase 0 | knowledge-quality Phase 0 소비만 | 평가를 위해 public config 시그니처 고정 |
| `src/chat/session.ts` | rag-trust Phase 1 | 후속 수정 없음 | `SourceRef` wire 계약 단일 owner |
| `src/cli/main.ts` | rag-trust Phase 1 | capture-governance Phase 1 | source 표시와 approve 명령을 같은 최종 파일에 보존 |
| `src/server/http-server.ts` | rag-trust Phase 1 | capture-governance Phase 1 | sources SSE와 approve endpoint를 함께 보존 |
| `src/server/public/index.html` | rag-trust Phase 1 | capture-governance Phase 1 | source link DOM과 captured review DOM을 함께 보존 |
| `package.json` | wiki-okf Phase 0 | knowledge-quality Phase 0 | `sync-wiki`를 보존하고 `wiki:check`, `eval:wiki` 추가 |
| `CLAUDE.md`, `README.md`, `docs/ROADMAP.md` | wiki-okf Phase 0 | knowledge-quality Phase 0 | 최종 계약은 knowledge-quality Phase 0이 결정 |

## 사전 컨텍스트 자동 감지 결과

- 플랫폼: TypeScript 5.6 + Node.js ESM + Node 표준 라이브러리 + Vitest 3
- region: 공통
- 변경 유형: feature + refactor + docs + CI
- 변경 크기: large, 구현/테스트/문서 약 30개 고유 파일과 generated OpenWiki 문서
- 위험도: internal
- critical 관점: 외부 모델 API credential, Markdown/YAML 입력 검증, 파일 경로 승인 API, 비동기 index mutation
- 이전 라운드 N+1 이력: GitHub PR 0건, local plan history cache 없음

## 도메인 sweep 결과

### RTB wiki

명령: `search_wiki(query="OpenWiki OKF RAG knowledge capture chatbot-engine")`

결과: 0 hits. 개인 학습 저장소라 RTB 정책은 적용하지 않는다.

### lore

명령: `lore_list_danger_zones({ repo: "chatbot-engine", files: [계획 변경 파일] })`

결과: danger zones 0건, related incidents 0건. lore index의 7개 repo 목록에 `chatbot-engine`이 없다.

### service-context

- Tier 1 `groups/ai.md`: ESM local import의 `.js` 확장자 규칙만 적용한다.
- Tier 2 `repos/chatbot-engine.md`: 파일 부재. 저장소의 `CLAUDE.md`를 ground truth로 사용한다.

## 스펙 정합성 검증 결과

- 활성 소스: 사용자 승인, `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/ROADMAP.md`, 기존 `docs/plans/openwiki-index.md`, TypeScript 타입, Vitest 테스트, OpenWiki 0.2.1 README, Google OKF v0.1 spec
- 비활성 소스: JIRA, Figma, OpenAPI, DB migration — 이 저장소와 변경 영역에 해당 없음
- 불일치 1: 기존 계획은 별도 wiki repo를 canonical로 지정하지만 승인된 새 결정은 repository `openwiki/`를 canonical로 지정한다.
- 불일치 2: `.gitignore`는 `openwiki/`를 무시하지만 cloud workflow는 `openwiki/`를 PR add-path로 지정한다.
- 불일치 3: OpenWiki CLI 문서는 존재하지 않는 `npm start`를 안내한다.
- 해소: Segment 1이 새 결정을 단일 소스로 반영하고 generated page는 OpenWiki로만 재작성한다.

## 코드 예시 적용 규칙

1. 상대 ESM import에는 `.js`를 붙인다.
   - 위반: `import { parse } from '../okf/document'`
   - 수정: `import { parse } from '../okf/document.js'`
2. `any`를 쓰지 않고 `unknown`과 타입 가드를 사용한다.
   - 위반: `const parsed: any = JSON.parse(raw)`
   - 수정: `const parsed: unknown = JSON.parse(raw)`
3. 런타임 의존성을 추가하지 않는다.
   - 위반: YAML parser npm package 추가
   - 수정: OKF가 사용하는 scalar와 flow-list만 표준 라이브러리로 파싱
4. 모든 파일 쓰기는 `writeFileAtomic`을 사용한다.
   - 위반: `writeFile(path, body)`
   - 수정: `writeFileAtomic(path, body)`
5. 외부 입력 경로는 `resolve` 후 base directory containment를 검증한다.
6. 테스트는 `.test-tmp/<randomUUID>`에서 격리하고 `afterEach`에서 제거한다.
7. generated `openwiki/*.md`는 손으로 수정하지 않고 OpenWiki 명령으로만 갱신한다.

## 코드 패턴 sweep 결과 (Hard gate)

| 차원 | 명령 | hit | 분류 |
|---|---|---:|---|
| Same File | `rg -n "score: 0|minScore|index.search" src/rag/hybrid-retriever.ts` | 2 categories, 3 locations | In-Scope: score/abstention |
| Adjacent Files | `rg -n "VectorIndex.create|VectorIndex.load|buildIndex|IndexedChunk" src eval` | 30+ references | In-Scope: index contract와 tests |
| Byproducts | `rg -n "saveCaptured|captureKnowledge|rebuildIndex|/captured|api/captured" src` | 35+ references | In-Scope: lifecycle/API/UX/tests |
| Workflow parity | `rg -n "openwiki|OPENWIKI|sync-wiki|dev-wiki" .github scripts package.json .gitignore AGENTS.md CLAUDE.md docs` | 30+ references | In-Scope: canonical 경로 단일화 |
| Frontmatter | `rg -n "^---$|^type:|^status:" openwiki` | 0 hits | In-Scope: OKF migration |
| Credential | `rg -n "API_KEY|TOKEN|TELEMETRY" .github CLAUDE.md` | 4 locations | In-Scope: secret env 보존, telemetry off |
| Input path | `rg -n "join\(|resolve\(|readBody|writeFileAtomic" src/knowledge src/server src/store` | join/write hits, resolve 0 | In-Scope: approve containment guard |
| Concurrency | `rg -n "chatting|rebuildIndex|captureKnowledge|Promise<" src/app src/server` | mutation serialization 없음 | In-Scope: serial mutation queue |

## 플랫폼 보안 + 안정성 sweep

| 관점 | 결과 | 분류 |
|---|---|---|
| 인증 우회 | 서버 기본 bind는 `127.0.0.1`; 기존 mutation endpoint에도 인증 없음 | Out-of-Scope: 외부 노출 인증은 별도 기능, 새 endpoint는 동일 local trust boundary |
| credential 노출 | GitHub secrets env 사용, 평문 key 없음 | In-Scope: telemetry disable, 로그에 env 출력 금지 |
| PII 전송 | cloud OpenWiki가 repository content를 OpenRouter에 전송 | 승인된 전제; README에 cloud/local 경계 명시 |
| 입력 검증 | approve id에 containment guard가 현재 없음 | In-Scope |
| 리소스 상한 | HTTP body 1MB 상한 존재, OKF frontmatter 상한 없음 | In-Scope: 64KiB frontmatter cap |
| 동시성 | index/capture mutation이 직렬화되지 않음 | In-Scope: promise tail queue |
| 에러 처리 | 파일/embedding/OpenWiki 외부 호출 실패 가능 | In-Scope: atomic write, queue failure recovery, workflow PR 실패 전파 |

## 형제 plan 교차

기존 `openwiki-*`, `rag-*`, `search-*`, `capture-*` plan은 모두 landing 완료 기록이 있는 과거 계획이며 동시 landing 대상이 아니다. 새 5개 segment 간 교집합은 이 master index의 owner 표로 고정했다.

## BE-FE 계약 경계

활성. 두 wire 계약을 변경한다.

| 계약 | Before | After | 소비자 |
|---|---|---|---|
| SSE `sources` | `{source, heading}` | `{source, heading, title?, resource?}` | CLI, browser source renderer |
| captured list | `{path,title,category}` | `{id,title,category,status}` | CLI `/captured`, Web review panel |
| captured approve | 없음 | `POST /api/captured/approve {id}` → `{entry,indexUpdated,warning?}` | CLI/Web approve consumer |

`resource`는 `http:` 또는 `https:` URL일 때만 anchor로 렌더한다. 그 외 URI와 누락값은 `textContent`로 표시한다.

## Stop-gap vs 근본 해결

| 발견 | Stop-gap | 근본 해결 | 선택 |
|---|---|---|---|
| stale wiki | 한 번 재생성 | canonical OKF + single workflow + PR review | 근본 |
| stale index | 생성 시각 경고 | content fingerprint mismatch 시 load 거부 | 근본 |
| 무관 retrieval | vector threshold만 추가 | scored RRF + strong-evidence gate + metadata + diversity + abstention | 근본 |
| capture 오염 | 수동 삭제 | draft/verified + provenance + 승인 | 근본 |
| 평가 공백 | 기존 20문항 유지 | wiki/no-answer/citation eval + CI validator | 근본 |

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|---|---|---|---|
| R1 | OpenWiki 생성 경로 비결정성 | M | M | INSTRUCTIONS에 required paths 고정, validator 실패 시 hand-edit 금지 |
| R2 | 0.88 vector/strong-evidence gate가 semantic recall 감소 | M | M | exact-title fallback과 wiki golden recall@4/no-answer accuracy 동시 측정 |
| R3 | 제한적 YAML parser가 지원 밖 문법을 만남 | M | M | 64KiB cap, 알려진 key만 파싱, 명시적 오류와 tests |
| R4 | index v2로 기존 `.chatbot/*.json` load 불가 | H | L | 파생 artifact로 취급, startup notice와 `/index` 재생성 문서화 |
| R5 | draft exclusion로 novelty 중복 판정이 약화 | M | H | draft도 index에는 포함하고 retriever에서만 제외 |
| R6 | approve path traversal 또는 symlink escape | M | H | 정확한 category/file.md 형식 + lexical/realpath containment + extension guard |
| R7 | concurrent capture/index/approve의 last-write-wins 또는 저장 후 rebuild 실패 | M | M | App mutation queue, capture/approval durable partial-success 결과, `/index` 복구와 failure test |
| R8 | cloud wiki 생성 시 repository content 외부 전송 | H | M | 공개 개인 repo 전제 명시, local Ollama fallback, telemetry disabled |

## 가정

- repository content는 이미 공개 GitHub에 있으며 OpenRouter 전송이 허용된다. 틀리면 workflow provider를 local self-hosted로 바꿔야 한다.
- `openwiki@0.2.1`이 Node 22에서 OKF v0.1을 생성한다. 틀리면 Phase 1 생성 gate에서 중단한다.
- corpus 규모가 수백 Markdown/수천 chunk 미만이다. 틀리면 full fingerprint scan과 in-memory index 성능을 재설계해야 한다.
- 서버는 기본 `127.0.0.1` trust boundary 안에서 동작한다. 틀리면 approve/capture/index endpoint 인증이 선행되어야 한다.

## YAGNI 체크

- 제외: vector DB, GraphRAG, full YAML 1.2, incremental embedding, LLM reranker, automatic LLM faithfulness judge, authentication, multi-user ownership, OpenWiki personal connectors.
- 이유: 현재 88 wiki chunks와 단일 사용자 local runtime에서는 correctness gate가 우선이다.

## Acceptance Criteria

- [ ] AC1: generated OpenWiki bundle이 OKF v0.1 validator를 통과한다.
- [ ] AC2: OpenWiki 자동화 workflow가 하나이며 exact version과 provider를 명시한다.
- [ ] AC3: 문서 내용이 바뀌면 저장된 index를 stale로 판정하고 retriever를 활성화하지 않는다.
- [ ] AC4: threshold vector 또는 full-title evidence가 없는 부분 lexical 질문은 RAG block과 sources를 반환하지 않는다.
- [ ] AC5: RRF hit는 0이 아닌 fused score를 보존하고 top-K에서 source diversity를 우선한다.
- [ ] AC6: draft captured knowledge는 novelty에는 쓰이지만 chat retrieval에는 노출되지 않는다.
- [ ] AC7: 승인된 captured knowledge만 verified로 바뀌며, 재색인 실패 시 `indexUpdated: false`와 `/index` 복구 안내가 반환된다.
- [ ] AC7-1: capture 저장 후 재색인 실패도 draft 경로와 `indexUpdated: false`를 반환해 재시도 중복을 피한다.
- [ ] AC8: traversal id, 존재하지 않는 id, 이미 승인된 id가 각각 명시적 오류를 반환한다.
- [ ] AC9: wiki retrieval eval이 recall@1, recall@4, MRR, no-answer accuracy를 출력한다.
- [ ] AC10: `npm test`, `npm run typecheck`, `npm run build`, `npm run wiki:check`가 통과한다.

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|---|---|---|
| in-repo `openwiki/` canonical | agent link와 PR review가 clone 하나에서 재현됨 | sibling dev-wiki canonical: clone/CI 경로 결합 |
| cloud PR workflow 단일화 | self-hosted runner 없이 schedule 동작 | local workflow only: runner availability 의존 |
| custom OKF subset parser | runtime dependency 0 유지 | YAML package: 런타임 의존성 증가 |
| full document fingerprint | corpus가 작고 정확함 | mtime: git checkout에서 신뢰 불가, incremental: 복잡도 증가 |
| draft도 embedding index 포함 | novelty 중복 방지 | draft 완전 제외: 반복 capture 중복 |
| retriever visibility filter | canonical/search trust 분리 | index 단계 draft drop: novelty와 충돌 |

## Rollback plan

- 각 segment를 독립 commit으로 만든다.
- 후행 segment rollback은 역순으로 revert한다.
- index schema는 파생 artifact이므로 rollback 후 `/index`로 재생성한다.
- generated wiki는 workflow PR 이전 commit으로 revert한다.
- DB와 외부 API contract migration은 없다.

## Migration plan

- breaking change: persisted RAG index v1 → v2. 기존 index는 재생성한다.
- wire compatibility: source의 신규 optional field는 기존 client와 호환된다.
- captured list의 `path` → `id`는 internal HTTP contract 변경이며 CLI/Web을 같은 Phase에서 갱신한다.
- rollout: 9개 Phase 순차 적용, 각 Phase에서 test/typecheck/build gate.

## 4-7 Plan 구조 리뷰 결과

Plan Review: 이슈 없음 (수정 후 재검증)

- Reviewers: Claude + Codex
- Mode: critical+warning
- 대상: `docs/plans/knowledge-system-index.md`와 5개 segment/9개 Phase
- 1차 발견: reviewer 출력 21건, 중복 병합 후 유효 이슈 18건
- 반영: quickstart required path, OKF/capture/build/retriever 계약 통일, metadata guard, command drift grammar, CLI test seam, real App HTTP fixture, lexical strong-evidence gate, symlink-aware id guard, 승인 후 rebuild 실패 복구 계약
- 재검증: 각 지적의 인용 위치와 형제 plan을 다시 확인했으며 잔존 Critical/Warning 0건
- 드롭: 0건
