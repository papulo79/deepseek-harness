#!/usr/bin/env bash
# Trae la última versión del proyecto original, rebasa los cambios locales
# encima y regenera la serie de parches.
#
#   ./local-changes/sync-upstream.sh          # solo local
#   ./local-changes/sync-upstream.sh --push   # además publica en el fork
#
# Variables de entorno: BRANCH (rama de trabajo), UPSTREAM (remoto original),
# UPSTREAM_BRANCH (rama de referencia).
set -euo pipefail

BRANCH="${BRANCH:-local/custom}"
UPSTREAM="${UPSTREAM:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"

push=0
case "${1:-}" in
  --push) push=1 ;;
  '') ;;
  *) echo "uso: $0 [--push]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: hay cambios sin commitear; commiteálos o descártalos antes de sincronizar" >&2
  exit 1
fi

echo "==> Descargando $UPSTREAM/$UPSTREAM_BRANCH"
git fetch "$UPSTREAM" --prune

# master se mantiene como espejo exacto de upstream para que el botón
# "Sync fork" de GitHub y los PRs contra upstream sigan funcionando.
if git show-ref --verify --quiet refs/heads/master; then
  if [ "$(git rev-parse --abbrev-ref HEAD)" = master ]; then
    git merge --ff-only "$UPSTREAM/$UPSTREAM_BRANCH"
  else
    git branch -f master "$UPSTREAM/$UPSTREAM_BRANCH" 2>/dev/null \
      || echo "aviso: master no se movió (¿está activa en otro worktree?)" >&2
  fi
fi

echo "==> Rebasando $BRANCH sobre $UPSTREAM/$UPSTREAM_BRANCH"
git checkout "$BRANCH"

if ! git rebase "$UPSTREAM/$UPSTREAM_BRANCH"; then
  cat >&2 <<'EOF'

error: el rebase quedó con conflictos.
  - resuélvelos, `git add` y `git rebase --continue`
  - o cancela todo con `git rebase --abort`
Vuelve a lanzar este script cuando el rebase termine para regenerar los parches.
EOF
  exit 1
fi

"$root/local-changes/export-patches.sh"

if [ -n "$(git status --porcelain -- local-changes/patches)" ]; then
  git add local-changes/patches
  git commit -m "chore(local-changes): regenerar la serie de parches" >/dev/null
  echo "==> Serie de parches actualizada en un commit nuevo"
fi

if [ "$push" = 1 ]; then
  echo "==> Publicando en origin"
  git push origin master
  git push --force-with-lease origin "$BRANCH"
fi

echo "==> Sincronizado. Reconstruye con: pnpm install && pnpm run build"
