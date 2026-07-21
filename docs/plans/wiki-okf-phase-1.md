# Phase 1: OKF bundle 재생성

@fidelity-check tokens: architecture/request-flow.md, components/native-inference.md, source-map.md, okf_version

## 코드 예시 적용 규칙

1. generated page를 직접 수정하지 않는다.
2. Node 22와 OpenWiki 0.2.1을 사용한다.
3. tool 실패 또는 required path 누락 시 Phase를 완료 처리하지 않는다.
4. `.last-update.json`은 commit하지 않는다.

## 전제 조건

```text
Canonical bundle: ./openwiki
Author brief: ./openwiki/INSTRUCTIONS.md
Automation: .github/workflows/openwiki-update.yml
OpenWiki version: 0.2.1
OKF version: 0.1
```

## 현재 상태

기존 generated wiki는 7개 Markdown이고 native inference, hybrid retrieval, capture lifecycle, source map이 누락되어 있다. OKF frontmatter는 없다.

## Step 1: OpenWiki 0.2.1 update 실행 (`openwiki/**` — generate)

### Context

cloud workflow와 같은 version을 local one-shot으로 실행한다. provider secret은 shell history나 plan 문서에 기록하지 않는다.

### Code

```bash
node --version
npx -y openwiki@0.2.1 code --update --print
```

실행 environment는 둘 중 하나만 사용한다.

```bash
# cloud-compatible environment
export OPENWIKI_PROVIDER=openrouter
export OPENWIKI_MODEL_ID=z-ai/glm-5.2
export OPENWIKI_TELEMETRY_DISABLED=true
# OPENROUTER_API_KEY는 현재 shell secret store에서 주입
```

```bash
# local fallback environment
export OPENWIKI_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
export OPENAI_COMPATIBLE_API_KEY=ollama
export OPENWIKI_MODEL_ID=qwen3:8b
export OPENWIKI_TELEMETRY_DISABLED=true
```

### Anchor

N/A — external generator가 `openwiki/`를 갱신한다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
for f in index.md quickstart.md architecture/overview.md architecture/request-flow.md components/native-inference.md components/rag.md components/knowledge-capture.md interfaces/cli-and-http.md operations/openwiki-and-deployment.md testing/evaluation.md reference/configuration.md source-map.md log.md; do test -f "openwiki/$f" || exit 1; done
# 기대: exit 0
```

### 동반 변경 (Side Effects)

OpenWiki가 `AGENTS.md`와 `CLAUDE.md`의 marker block을 갱신할 수 있다. marker 밖 user content 변경은 허용하지 않는다.

### Do Not Touch

`openwiki/INSTRUCTIONS.md`.

## Step 2: OKF v0.1 구조 정적 gate (`openwiki/**` — verify)

### Context

knowledge-quality Phase 0의 validator가 아직 없으므로 이 Phase는 shell gate로 required metadata와 알려진 stale fact를 검사한다.

### Code

```bash
concepts=$(find openwiki -type f -name '*.md' ! -name 'index.md' ! -name 'log.md' ! -name 'INSTRUCTIONS.md' | sort)
test -n "$concepts"
while IFS= read -r file; do
  first=$(sed -n '1p' "$file")
  test "$first" = '---' || exit 1
  sed -n '2,/^---$/p' "$file" | rg -q '^type:[[:space:]]*[^[:space:]]' || exit 1
done <<< "$concepts"
rg -q 'okf_version:[[:space:]]*["'"']0\.1["'"']' openwiki/index.md
! rg -n 'npm start|node src/cli/main\.ts' openwiki
```

### Anchor

N/A — 검증 명령.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
rg -l '^type:' openwiki --glob '*.md' | wc -l && rg -n 'HybridRetriever|NativeLlmClient|captureKnowledge|SourceRef' openwiki
# 기대: concept 수만큼 type 파일, 4개 symbol 모두 문서에 존재
```

### 동반 변경 (Side Effects)

gate 실패 시 generated page를 손으로 고치지 않는다. 동일 exact command를 한 번 재실행한다. 두 번째 실패 시 Phase를 blocked로 보고한다.

### Do Not Touch

runtime source code.

## Step 3: generated diff 검토 (`openwiki/**`, `AGENTS.md`, `CLAUDE.md` — verify)

### Context

생성 모델이 marker 밖 문서나 secret-like text를 추가하지 않았는지 확인한다.

### Code

```bash
git diff -- openwiki AGENTS.md CLAUDE.md
rg -n -i 'api[_-]?key[=:][[:space:]]*[A-Za-z0-9_-]{12,}|token[=:][[:space:]]*[A-Za-z0-9_-]{12,}' openwiki AGENTS.md CLAUDE.md && exit 1 || true
```

### Anchor

N/A — review gate.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
git diff --name-only -- openwiki AGENTS.md CLAUDE.md | sort
# 기대: openwiki generated files와 marker-managed agent files만 출력
```

### 동반 변경 (Side Effects)

N/A — 생성 결과 검토만 수행한다.

### Do Not Touch

marker 밖 `AGENTS.md`, `CLAUDE.md` user content.

## 실행 순서

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3

## 입출력 예제

| 입력 | 출력 |
|---|---|
| current repository + INSTRUCTIONS | required 13-path OKF bundle |
| stale command search | 0 hits |
| secret-like regex | 0 hits |

## 이 Phase 완료 후 노출 인터페이스

```text
OKF bundle root: openwiki/index.md
Required concept paths: openwiki/INSTRUCTIONS.md의 Required paths
Generated change history: openwiki/log.md
```

## Definition of Done

- [ ] DoD-11: required path 13개 존재
- [ ] DoD-12: every concept has non-empty type
- [ ] DoD-13: root index declares okf_version 0.1
- [ ] DoD-14: stale commands 0건
- [ ] DoD-15: secret-like text 0건
- [ ] DoD-16: test/typecheck/build PASS

## Observability plan

- 로깅: OpenWiki stdout와 generated `log.md`
- 메트릭: generated concept 수와 required path pass/fail
- 알림: workflow failure와 PR review
- 대시보드: N/A

## 최종 검증

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
