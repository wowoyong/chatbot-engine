# ROADMAP — chatbot-engine 다음 단계

> 2026-07-11 기준. 설계 문서의 Segment 1~6 + 웹 + knowledge-capture + GitHub 업로드 완료 상태에서의 후속 계획.
> 각 항목은 rtb:plan 워크플로우(사전 분석 → 계획서 → 구현 → 게이트)로 진행한다. 근거는 전부 실측 — `docs/plans/*-index.md`의 기록 참조.

## Track A — 검색 품질: 하이브리드 검색 + 평가 세트 ⭐ 1순위

**지금 가능** · 규모: Medium (2~3 Phase) · 전제조건: 없음

| 항목 | 내용 |
|------|------|
| 근거 (실측) | ① 자기유사 코퍼스에서 정답 청크가 top-4 탈락 (Segment 3 AC2) ② nomic 임베딩의 유사도 기준선 문제 — 무관 한국어 문장도 0.77~0.87 (Segment 6 발견) |
| A-1 평가 세트 | 골든 질문 ~20개(질문→정답 청크 매핑) + `npm run eval` — recall@K, MRR 산출. **검색 개선의 전제** (측정 없는 튜닝 금지) |
| A-2 BM25 밑바닥 구현 | 키워드 검색 ~60줄 (토크나이즈·IDF·TF 정규화) — 의존성 0 유지 |
| A-3 하이브리드 결합 | 벡터+BM25를 RRF(Reciprocal Rank Fusion)로 결합, eval로 전후 비교 |
| 완료 기준 | eval 지표가 벡터 단독 대비 개선을 숫자로 입증, 기존 114 테스트 회귀 없음 |

## Track B — 퀵윈 3종 (반나절감, 아무 때나)

**지금 가능** · 규모: Small ×3 · 전제조건: 없음

1. **웹 UI 출처 표시** — `RetrievedContext.hits`가 이미 있는데 UI 미노출. 답변 아래 접이식 "참조 문서 N건" 표시. (서버가 hits를 SSE 메타 이벤트로 전달 필요 — wire 계약 1건 추가)
2. **응답 중단 버튼** — fetch AbortController + 서버 `res.destroyed`/`req close` 감지 보강 (Segment 5에서 기록한 "중단 감지 best-effort" 뉘앙스도 이때 함께 해소)
3. **실측 토큰 수** — ndjson done 청크의 `prompt_eval_count`를 파서가 버리는 중 (Segment 2 Out-of-Scope 항목). 노출해서 휴리스틱 추정 보정 — `parseNdjsonStream` 인터페이스 확장 필요(메타 채널)라 셋 중 가장 큼

## Track C — 맥미니 배포 + 자동화 (운영 단계)

**부분 가능** · 규모: Medium · 전제조건: 맥미니 접근 (⑤~⑥), 나머지는 지금 가능

1. ~~GitHub 업로드~~ ✅ (wowoyong/chatbot-engine, wowoyong/dev-wiki)
2. **PAT 정리** — 대화에 노출된 토큰 revoke + 재발급, `env -u GITHUB_TOKEN gh auth login`으로 개인 계정 keyring 등록 (사용자 직접)
3. **OpenWiki Actions workflow 작성** — `.github/workflows/openwiki.yml` (지금 작성 가능, 실행은 ⑤ 이후)
4. **README 정비** — 공개 레포 첫인상: 프로젝트 소개·아키텍처 다이어그램·실행법 (지금 가능)
5. **맥미니 self-hosted runner 등록** — 커밋마다 로컬 Ollama(8b)로 wiki 자동 갱신 → 클라우드 비용 0의 완전 자동 문서화 루프
6. **launchd 상시 구동** — `HOST=0.0.0.0 npm run serve` 서비스화 + 재부팅 자동 시작. **런타임 qwen3:8b 고정** (16GB 제약)

## Track D — 캡처 품질 (LangChain 학습의 역이식)

**지금 가능** · 규모: Small~Medium · 전제조건: 없음

| 항목 | 내용 |
|------|------|
| 근거 (실측) | ① 8B가 봇 맞장구를 지식으로 추출("ai-기억-확인") ② 같은 대화에서 "추출 0건" 변동 (Segment 6) |
| D-1 구조화 출력 | Ollama native `format`(JSON 스키마) 도입 — 손파싱 40줄 대체, LC의 withStructuredOutput 대응물을 밑바닥으로 |
| D-2 추출 프롬프트 개선 | "어시스턴트 발화만으로 성립하는 항목 제외" 등 노이즈 필터 — A-1 평가 세트 방식으로 추출 품질도 골든 케이스 측정 |
| D-3 캡처 관리 UX | `/captured` 목록·삭제 명령 + 웹 노출 — 쌓인 지식의 큐레이션 진입점 |

## Track E — 백로그 (조건 성숙 시)

- **멀티세션** — 웹 탭/주제별 스레드 (LangGraph thread_id 개념의 밑바닥 이식). 단일 사용자 불편이 실제로 생기면
- **간단 인증** — 서버를 LAN 밖에 노출할 계획이 생기면 (현재 127.0.0.1 기본이라 불필요)
- **마크다운 렌더링** — 웹 UI 답변의 코드블록/목록 표시 (XSS 방지 textContent 원칙과의 절충 설계 필요)
- **요약 품질 개선** — 요약의 요약(증분 압축), 장기 대화 실사용 후
- **캡처 자동화** — /exit 시 자동 캡처 등. D-2 품질 검증 후

## 권장 진행 순서

```
A-1 (평가 세트) → B 퀵윈 → A-2·A-3 (하이브리드) → C-3·C-4 (workflow·README)
→ [맥미니 접근 가능 시] C-5·C-6 → D → E
```

A-1을 맨 앞에 두는 이유: 평가 세트가 생기면 이후 모든 변경(검색·캡처·청킹·임계값)이 "느낌"이 아니라 숫자로 검증된다.
