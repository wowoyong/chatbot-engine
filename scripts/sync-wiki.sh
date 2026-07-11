#!/usr/bin/env bash
# openwiki/ 산출물을 별도 wiki 레포로 동기화하고 커밋한다 (멱등).
set -euo pipefail

WIKI_REPO="${WIKI_REPO:-../chatbot-engine-wiki}"

if [ ! -d openwiki ]; then
  echo "오류: openwiki/ 디렉토리가 없습니다. 먼저 'openwiki code --init'을 실행하세요." >&2
  exit 1
fi
if [ ! -d "$WIKI_REPO/.git" ]; then
  echo "오류: wiki 레포($WIKI_REPO)가 git 저장소가 아닙니다." >&2
  exit 1
fi

rsync -a --delete --exclude '.last-update.json' openwiki/ "$WIKI_REPO/wiki/"

cd "$WIKI_REPO"
git add -A
if git diff --cached --quiet; then
  echo "변경 없음 — wiki 최신 상태"
else
  git commit -m "sync: openwiki 산출물 갱신" >/dev/null
  echo "커밋 완료: $(git log --oneline -1)"
fi
echo "synced → $WIKI_REPO/wiki"
