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
