#!/usr/bin/env bash
# openwiki/ 산출물을 모노레포형 wiki 레포의 프로젝트 네임스페이스로 동기화하고 커밋한다 (멱등).
set -euo pipefail

WIKI_REPO="${WIKI_REPO:-../dev-wiki}"
WIKI_SUBDIR="${WIKI_SUBDIR:-chatbot-engine}"

if [ ! -d openwiki ]; then
  echo "오류: openwiki/ 디렉토리가 없습니다. 먼저 'openwiki code --init'을 실행하세요." >&2
  exit 1
fi
if [ ! -d "$WIKI_REPO/.git" ]; then
  echo "오류: wiki 레포($WIKI_REPO)가 git 저장소가 아닙니다." >&2
  exit 1
fi

rsync -a --delete --exclude '.last-update.json' openwiki/ "$WIKI_REPO/$WIKI_SUBDIR/"

cd "$WIKI_REPO"
git add -A -- "$WIKI_SUBDIR"
if git diff --cached --quiet; then
  echo "변경 없음 — wiki 최신 상태"
else
  git commit -m "sync($WIKI_SUBDIR): openwiki 산출물 갱신" >/dev/null
  echo "커밋 완료: $(git log --oneline -1)"
fi
echo "synced → $WIKI_REPO/$WIKI_SUBDIR"
