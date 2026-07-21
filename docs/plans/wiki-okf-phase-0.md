# Phase 0: Canonical OKF 계약과 workflow 단일화

@fidelity-check tokens: OPENWIKI_TELEMETRY_DISABLED, openwiki@0.2.1, /openwiki/.last-update.json, INSTRUCTIONS.md

## 코드 예시 적용 규칙

1. generated `openwiki/*.md`는 직접 수정하지 않는다.
2. OpenWiki 실행 runtime은 Node 22로 고정한다.
3. secret 값은 workflow expression으로만 전달하고 출력하지 않는다.
4. local OpenWiki command도 exact version `0.2.1`을 사용한다.
5. `scripts/sync-wiki.sh`는 `set -euo pipefail`을 유지한다.

## 전제 조건

없음.

## 현재 상태

- `.gitignore`가 `openwiki/` 전체를 무시한다.
- cloud scheduled workflow와 self-hosted workflow가 같은 name으로 공존한다.
- cloud workflow는 provider를 명시하지 않고 unpinned global OpenWiki를 설치한다.
- sync script가 `INSTRUCTIONS.md`까지 sibling mirror에 복사할 수 있다.
- `CLAUDE.md`는 sibling dev-wiki를 canonical로 설명한다.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|---|---|---|---|
| OpenWiki CLI | ✓ workflow command/version env | ✗ external CLI | Phase 1 file/content gate로 검증 |
| OpenRouter secret | ✓ GitHub secret env | ✗ CI 밖 실호출 없음 | workflow syntax와 env name 정적 검증 |
| sibling dev-wiki | ✓ `WIKI_REPO` env | ✓ temp git repo로 수동 검증 가능 | optional mirror라 CI 필수 조건에서 제외 |

## Step 1: canonical bundle 추적 허용 (`.gitignore` — modify)

### Context

`openwiki/` 전체 ignore를 제거하고 OpenWiki의 local run metadata만 ignore한다.

### Code

```gitignore
node_modules/
dist/
*.log
.DS_Store
.chatbot/
.test-tmp/

/openwiki/.last-update.json
```

### Anchor

`.gitignore` 전체를 교체한다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: 179 passed 이상, 기존 7 integration skip 허용

# 3. 의미 검증
git check-ignore openwiki/.last-update.json && ! git check-ignore openwiki/quickstart.md
# 기대: 첫 명령 0, 두 번째 명령이 ignore하지 않음
```

### 동반 변경 (Side Effects)

Phase 1에서 generated bundle 전체를 git diff 대상으로 만든다.

### Do Not Touch

`.chatbot/`, `node_modules/`, `dist/` ignore 규칙.

## Step 2: OpenWiki 생성 계약 작성 (`openwiki/INSTRUCTIONS.md` — create)

### Context

OpenWiki 0.2.1은 이 파일을 user-authored brief로 읽고 normal update에서 덮어쓰지 않는다. generated path와 검증할 사실을 고정한다.

### Code

```markdown
# chatbot-engine Wiki Generation Contract

Generate an OKF v0.1 knowledge bundle for this repository. Write generated documentation in Korean, while preserving code symbols, environment variables, commands, and file paths exactly.

## Required paths

- `index.md`
- `quickstart.md`
- `architecture/overview.md`
- `architecture/request-flow.md`
- `components/native-inference.md`
- `components/rag.md`
- `components/knowledge-capture.md`
- `interfaces/cli-and-http.md`
- `operations/openwiki-and-deployment.md`
- `testing/evaluation.md`
- `reference/configuration.md`
- `source-map.md`
- `log.md`

## Required coverage

- Explain the complete `ChatSession.send()` request flow from retrieval to SSE/CLI rendering.
- Document Ollama and native GGUF inference as separate `LlmClient` implementations.
- Document vector + BM25 + RRF hybrid retrieval, index persistence, and `/index`.
- Document conversation knowledge extraction, novelty detection, capture storage, and approval lifecycle.
- Document CLI commands, HTTP routes, SSE event shapes, and every supported environment variable.
- Document deterministic unit tests separately from Ollama/GGUF-gated integration tests.
- Include a source map from every documented component to concrete files under `src/`, `eval/`, `.github/`, and `scripts/`.

## Accuracy rules

- Read `package.json` before documenting commands. Do not invent `npm start`.
- Read current TypeScript before stating behavior or test counts.
- Mark generated pages with OKF frontmatter containing at least `type`, `title`, `description`, `tags`, and `timestamp`.
- Use standard Markdown links between related concepts.
- Treat `INSTRUCTIONS.md` as author-owned configuration; do not list it as a concept.
- Do not copy secrets, `.chatbot/` contents, model weights, or generated `dist/` output.
```

### Anchor

N/A — 새 파일.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
rg -n "Required paths|native-inference|knowledge-capture|Do not invent `npm start`" openwiki/INSTRUCTIONS.md
# 기대: 4개 pattern 모두 match
```

### 동반 변경 (Side Effects)

Step 5에서 sibling mirror가 이 author configuration을 복사하지 않도록 제외한다.

### Do Not Touch

기존 generated `openwiki/*.md`.

## Step 3: cloud PR workflow 고정 (`.github/workflows/openwiki-update.yml` — modify)

### Context

Node 22, OpenWiki 0.2.1, OpenRouter provider를 고정한다. telemetry를 끄고 generated bundle을 PR로 리뷰한다.

### Code

```yaml
name: OpenWiki Update

on:
  workflow_dispatch:
  schedule:
    - cron: "0 8 * * *"

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Install OpenWiki
        run: npm install --global openwiki@0.2.1

      - name: Run OpenWiki
        run: openwiki code --update --print
        env:
          OPENWIKI_PROVIDER: openrouter
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          OPENWIKI_MODEL_ID: z-ai/glm-5.2
          OPENWIKI_TELEMETRY_DISABLED: "true"
          LANGSMITH_API_KEY: ${{ secrets.LANGSMITH_API_KEY }}
          LANGCHAIN_PROJECT: openwiki
          LANGCHAIN_TRACING_V2: "true"

      - name: Create OpenWiki update pull request
        uses: peter-evans/create-pull-request@22a9089034f40e5a961c8808d113e2c98fb63676 # v7
        with:
          add-paths: |
            openwiki
            AGENTS.md
            CLAUDE.md
            .github/workflows/openwiki-update.yml
          branch: openwiki/update
          commit-message: "docs: update OpenWiki"
          title: "docs: update OpenWiki"
          body: |
            Automated OpenWiki 0.2.1 / OKF v0.1 documentation update.

            Review generated facts, links, commands, and source mappings before merge.
```

### Anchor

`.github/workflows/openwiki-update.yml` 전체를 교체한다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
rg -n "openwiki@0.2.1|OPENWIKI_PROVIDER: openrouter|OPENWIKI_TELEMETRY_DISABLED" .github/workflows/openwiki-update.yml
# 기대: 3 hits
```

### 동반 변경 (Side Effects)

Step 4에서 duplicate workflow를 제거한다.

### Do Not Touch

`.github/workflows/ci.yml` — knowledge-quality Phase 0 owner.

## Step 4: duplicate self-hosted workflow 제거 (`.github/workflows/openwiki.yml` — delete)

### Context

같은 이름과 다른 sink를 가진 self-hosted workflow는 단일 자동화 결정과 충돌한다. local Ollama는 workflow가 아니라 documented manual fallback으로 유지한다.

### Code

```bash
git rm .github/workflows/openwiki.yml
```

### Anchor

파일 전체 삭제.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
test ! -e .github/workflows/openwiki.yml && test "$(rg -l '^name: OpenWiki Update$' .github/workflows | wc -l | tr -d ' ')" = "1"
# 기대: exit 0
```

### 동반 변경 (Side Effects)

Step 6에서 local fallback 명령을 문서화한다.

### Do Not Touch

cloud workflow.

## Step 5: mirror에서 author config 제외 (`scripts/sync-wiki.sh` — modify)

### Context

optional `dev-wiki` mirror에는 generated OKF bundle만 복사하고 repository-specific author brief는 제외한다.

### Code

```bash
#!/usr/bin/env bash
# openwiki/ generated bundle을 dev-wiki의 project namespace로 동기화하고 commit한다.
set -euo pipefail

WIKI_REPO="${WIKI_REPO:-../dev-wiki}"
WIKI_SUBDIR="${WIKI_SUBDIR:-chatbot-engine}"

if [ ! -d openwiki ]; then
  echo "오류: openwiki/ 디렉토리가 없습니다. 먼저 OpenWiki update를 실행하세요." >&2
  exit 1
fi
if [ ! -d "$WIKI_REPO/.git" ]; then
  echo "오류: wiki 레포($WIKI_REPO)가 git 저장소가 아닙니다." >&2
  exit 1
fi

rsync -a --delete \
  --exclude '.last-update.json' \
  --exclude 'INSTRUCTIONS.md' \
  openwiki/ "$WIKI_REPO/$WIKI_SUBDIR/"

cd "$WIKI_REPO"
git add -A -- "$WIKI_SUBDIR"
if git diff --cached --quiet; then
  echo "변경 없음 — wiki mirror 최신 상태"
else
  git commit -m "sync($WIKI_SUBDIR): openwiki generated bundle 갱신" >/dev/null
  echo "커밋 완료: $(git log --oneline -1)"
fi
echo "synced → $WIKI_REPO/$WIKI_SUBDIR"
```

### Anchor

`scripts/sync-wiki.sh` 전체를 교체한다.

### Verify

```bash
# 1. 빌드
bash -n scripts/sync-wiki.sh
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
rg -n "exclude 'INSTRUCTIONS.md'|generated bundle" scripts/sync-wiki.sh
# 기대: 2 hits
```

### 동반 변경 (Side Effects)

N/A — optional mirror command의 output scope만 좁힌다.

### Do Not Touch

mirror repository 자체.

## Step 6: 운영 계약 문서화 (`CLAUDE.md`, `README.md`, `docs/ROADMAP.md` — modify)

### Context

canonical 위치, cloud automation, local fallback, optional mirror를 한 문장씩 고정한다. 최종 명령 목록은 knowledge-quality Phase 0이 다시 검증한다.

### Code

```markdown
<!-- CLAUDE.md의 기존 wiki 갱신/습득 2개 bullet 교체 -->
- canonical wiki: repository의 `openwiki/` OKF v0.1 bundle. generated Markdown은 직접 수정하지 않고 OpenWiki PR로만 갱신
- cloud 갱신: `.github/workflows/openwiki-update.yml`이 Node 22 + `openwiki@0.2.1` + OpenRouter로 PR 생성
- local fallback: `npx -y openwiki@0.2.1 code --update --print` (Node 22 + Ollama/OpenAI-compatible env 필요)
- optional mirror: `npm run sync-wiki`가 generated bundle만 `../dev-wiki/chatbot-engine/`로 복사
- 챗봇의 자기 wiki 습득: `RAG_DOCS_DIR=openwiki CHATBOT_INDEX_FILE=.chatbot/wiki-index.json npm run dev` 후 `/index`
```

```markdown
<!-- README.md의 "다음 단계" 직전에 삽입 -->
## Agent-readable wiki

`openwiki/`는 OpenWiki 0.2.1이 생성하는 canonical OKF v0.1 bundle이다. GitHub Actions가 변경 PR을 만들며 generated page는 직접 수정하지 않는다. 로컬 생성은 Node 22에서 `npx -y openwiki@0.2.1 code --update --print`를 사용한다. `npm run sync-wiki`는 선택적으로 generated bundle을 `dev-wiki`에 mirror한다.
```

```markdown
<!-- docs/ROADMAP.md Track C의 OpenWiki 항목 교체 -->
3. **OpenWiki 0.2.1 + OKF 자동화** — in-repo canonical bundle, cloud PR workflow, local Ollama fallback, optional dev-wiki mirror. 구현 plan: `docs/plans/wiki-okf-index.md`.
```

### Anchor

- `CLAUDE.md`: `- wiki 갱신:`과 다음 `- 챗봇의 wiki 습득:` 두 줄을 교체한다.
- `README.md`: `## 다음 단계` 바로 위에 삽입한다.
- `docs/ROADMAP.md`: Track C 3번 OpenWiki 항목을 교체한다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
rg -n "canonical wiki|openwiki@0.2.1|Agent-readable wiki|OpenWiki 0.2.1 \+ OKF" CLAUDE.md README.md docs/ROADMAP.md
# 기대: 각 문서에서 1개 이상 match
```

### 동반 변경 (Side Effects)

knowledge-quality Phase 0에서 최종 script와 eval 명령을 추가한다.

### Do Not Touch

OpenWiki marker block 문구는 OpenWiki tool만 수정한다.

## 실행 순서

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3
- [ ] Step 4
- [ ] Step 5
- [ ] Step 6

## 입출력 예제

| 입력 | 출력 |
|---|---|
| scheduled workflow | `openwiki/update` PR |
| local fallback command | repository `openwiki/` update |
| `npm run sync-wiki` | optional sibling mirror commit |

## 이 Phase 완료 후 노출 인터페이스

```text
Canonical bundle: ./openwiki
Author brief: ./openwiki/INSTRUCTIONS.md
Automation: .github/workflows/openwiki-update.yml
OpenWiki version: 0.2.1
OKF version: 0.1
```

## Definition of Done

- [ ] DoD-01: 모든 Step Verify 통과
- [ ] DoD-02: OpenWiki workflow 1개
- [ ] DoD-03: `.last-update.json`만 ignore
- [ ] DoD-04: secret 평문 0건
- [ ] DoD-05: test/typecheck/build PASS
- [ ] DoD-06: Phase 1 전제 조건 만족

## Observability plan

- 로깅: GitHub Actions step output와 PR body
- 메트릭: N/A
- 알림: workflow failure 기본 GitHub notification
- 대시보드: N/A

## 최종 검증

```bash
bash -n scripts/sync-wiki.sh
npm test
npm run typecheck
npm run build
git status --short
```
