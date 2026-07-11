# Phase 0: 프로젝트 스캐폴딩

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
   - 위반: `import { x } from './types'`
   - 수정: `import { x } from './types.js'`
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
   - 위반: `const data: any = JSON.parse(line)`
   - 수정: `const data: unknown = JSON.parse(line)` 후 타입 가드 함수로 좁히기
3. 런타임 의존성 추가 금지 — `dependencies`는 빈 상태 유지, `devDependencies`만 허용
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어 바인딩
5. `noUncheckedIndexedAccess` 활성 — 배열/인덱스 접근 결과는 `undefined` 가드 필수

## 전제 조건

없음.

## 현재 상태

신규 레포 (`main@14c2a44`). `docs/` 외 파일 없음. Node v20.19.6 확인됨.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| fetch (HTTP) | ✓ (생성자 `fetchFn` 파라미터 — Phase 1) | ✓ | — |
| Ollama 서버 | ✗ (외부 프로세스) | ✓ (`fetchFn` mock으로 완전 대체) | 실서버 검증은 최종 AC 수동 시나리오로 |
| stdin/stdout (readline) | ✗ (전역 스트림) | ✗ | CLI를 얇은 I/O 레이어로 유지, 로직은 ChatSession에 격리 (Phase 2) |
| 타이머 (timeout) | ✓ (`ChatOptions.timeoutMs` 주입) | ✗ (실제 setTimeout 사용) | fake timer 기반 타임아웃 테스트는 Follow-up Issue |

## Step 1: 패키지 매니페스트 생성 (`package.json` — create)

### Context

프로젝트 루트에 패키지 매니페스트가 없다. ESM(`"type": "module"`) + zero runtime dependency 원칙.

### Code
```json
{
  "name": "chatbot-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "tsx src/cli/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^20.19.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm install 2>&1 | tail -5
  # 기대: "added N packages" 출력, 에러 없음
# 2. 테스트
echo "N/A: 테스트 인프라는 Step 4에서 구성"
# 3. 의미 검증
node -e "const p=require('./package.json'); if(p.dependencies) throw new Error('런타임 의존성 금지 위반'); console.log('OK: zero runtime deps')"
  # 기대: "OK: zero runtime deps"
```

### 동반 변경 (Side Effects)

외부 의존성 추가 → lock 파일(`package-lock.json`)이 `npm install`로 생성되어 커밋에 포함됨. 캐시 우회 옵션(`--prefer-online` 등) 사용하지 않음.

### Do Not Touch

`docs/` 전체.

## Step 2: TypeScript 설정 (`tsconfig.json` — create)

### Context

typecheck 전용 기본 설정. 빌드 산출은 Step 3의 `tsconfig.build.json`이 담당.

### Code
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src", "vitest.config.ts"]
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
echo "N/A: typecheck는 Step 6 (src/index.ts 생성) 이후 실행 가능 — 최종 검증에서 수행"
# 2. 테스트
echo "N/A: 설정 파일"
# 3. 의미 검증
node -e "const t=require('./tsconfig.json').compilerOptions; if(!t.strict||!t.noUncheckedIndexedAccess) throw new Error('strict 설정 누락'); console.log('OK: strict')"
  # 기대: "OK: strict"
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

`package.json` (Step 1 완료본).

## Step 3: 빌드 전용 TypeScript 설정 (`tsconfig.build.json` — create)

### Context

`dist/` 산출 시 테스트 파일을 제외하기 위한 빌드 전용 설정. `tsconfig.json`을 상속.

### Code
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["src/**/__tests__/**"]
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
echo "N/A: 빌드는 Step 6 (src/index.ts 생성) 이후 최종 검증에서 수행"
# 2. 테스트
echo "N/A: 설정 파일"
# 3. 의미 검증
node -e "const t=require('./tsconfig.build.json'); if(!t.exclude.includes('src/**/__tests__/**')) throw new Error('테스트 제외 누락'); console.log('OK: test excluded')"
  # 기대: "OK: test excluded"
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

`tsconfig.json` (Step 2 완료본).

## Step 4: Vitest 설정 (`vitest.config.ts` — create)

### Code
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    passWithNoTests: true,
  },
});
```

### Context

테스트 위치 컨벤션: `src/**/__tests__/<파일명>.test.ts`. Phase 0 시점에는 테스트 파일이 없으므로 `passWithNoTests: true`로 빈 상태에서도 exit 0.

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
echo "N/A: 설정 파일"
# 2. 테스트
npx vitest run 2>&1 | tail -3
  # 기대: "no test files found" 안내와 함께 exit code 0
# 3. 의미 검증
npx vitest run > /dev/null 2>&1 && echo "OK: passWithNoTests"
  # 기대: "OK: passWithNoTests"
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

`package.json`, `tsconfig.json`, `tsconfig.build.json`.

## Step 5: gitignore (`.gitignore` — create)

### Code
```
node_modules/
dist/
*.log
.DS_Store
```

### Context

표준 Node 프로젝트 제외 목록.

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
echo "N/A: 설정 파일"
# 2. 테스트
echo "N/A: 설정 파일"
# 3. 의미 검증
git check-ignore node_modules && echo "OK: ignored"
  # 기대: "node_modules" + "OK: ignored"
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

기존 파일 전체.

## Step 6: 엔트리 placeholder (`src/index.ts` — create)

### Context

tsc가 컴파일할 입력이 최소 1개 필요 ("No inputs were found" 에러 방지). 라이브러리 루트 export 지점으로 이후 Phase에서 확장.

### Code
```ts
export const ENGINE_VERSION = '0.1.0';
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 출력 없음 (exit 0)
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: exit 0 (passWithNoTests)
# 3. 의미 검증
npm run build 2>&1 | tail -3 && test -f dist/index.js && echo "OK: dist emitted"
  # 기대: "OK: dist emitted"
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

설정 파일 전체 (Step 1~5 완료본).

## Step 7: 프로젝트 지침 (`CLAUDE.md` — create)

### Context

빌드/테스트 명령과 컨벤션을 기록. 이후 Segment 4에서 OpenWiki가 이 파일에 wiki 참조를 삽입할 예정.

### Code
```markdown
# chatbot-engine

Qwen3 8B(로컬 Ollama) 기반 대화형 챗봇 엔진 — 프레임워크 없이 밑바닥부터 구현하는 학습 프로젝트.
설계 문서: `docs/superpowers/specs/2026-07-11-chatbot-engine-design.md`

## 명령어

- `npm run dev` — CLI REPL 실행 (로컬 Ollama + qwen3:8b 필요)
- `npm test` — 단위 테스트 (Ollama 불필요 — fetch mock)
- `npm run typecheck` — 타입 검사 (테스트 포함)
- `npm run build` — dist/ 산출 (테스트 제외)

## 컨벤션

- ESM (NodeNext) — 상대 import에 `.js` 확장자 필수
- `any` 금지 — `unknown` + 타입 가드
- 런타임 의존성 0개 유지 (Segment 1~3 동안)
- 테스트 위치: `src/**/__tests__/<파일명>.test.ts` (Vitest)
- LLM 호출 경계는 `src/llm/types.ts`의 `LlmClient` 인터페이스를 통해서만
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
echo "N/A: 문서"
# 2. 테스트
echo "N/A: 문서"
# 3. 의미 검증
grep -c "LlmClient" CLAUDE.md
  # 기대: 1
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

`docs/` 전체.

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6 → 7 (Step 1의 `npm install`이 이후 모든 Verify의 전제).

## 입출력 예제

| 명령 | 기대 출력 |
|------|----------|
| `npm run typecheck` | 출력 없음, exit 0 |
| `npm test` | "no test files found", exit 0 |
| `npm run build && ls dist` | `index.js`, `index.d.ts` 등 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/index.ts
export const ENGINE_VERSION = '0.1.0';
```

설정 파일: `package.json`(scripts: dev/build/typecheck/test), `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`.

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify 명령 ✓
- [ ] DoD-02: `npm run typecheck` exit 0
- [ ] DoD-03: `npm test` exit 0 (passWithNoTests)
- [ ] DoD-04: `npm run build` 후 `dist/index.js` 존재
- [ ] DoD-05: CLAUDE.md 커밋됨
- [ ] DoD-06: Phase 1 전제 조건 만족 (스캐폴딩 완료)

## Observability plan

N/A — 운영 영향 없음 (로컬 학습 프로젝트 스캐폴딩)

## 최종 검증

```bash
npm install && npm run typecheck && npm test && npm run build && test -f dist/index.js && echo "PHASE 0 PASS"
```
