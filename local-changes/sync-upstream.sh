#!/usr/bin/env bash
# Actualiza el fork con la última versión del proyecto original.
#
# La rama de trabajo solo acepta cambios por pull request, así que esto no
# rebasa: crea una rama con la fusión de upstream, la publica, abre el PR y lo
# fusiona. `master`, que es el espejo, sí se publica directamente.
#
#   ./local-changes/sync-upstream.sh          # prepara la rama de fusión, sin publicar
#   ./local-changes/sync-upstream.sh --push   # publica, abre el PR y lo fusiona
#   ./local-changes/sync-upstream.sh --ayuda
#
# Variables de entorno: BRANCH (rama de trabajo), UPSTREAM (remoto original),
# UPSTREAM_BRANCH (rama de referencia), DSH_WEB_DIR (carpeta del lanzador
# instalado; se refresca al terminar si existe).
set -euo pipefail

BRANCH="${BRANCH:-local/custom}"
UPSTREAM="${UPSTREAM:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
DSH_WEB_DIR="${DSH_WEB_DIR:-$HOME/Desarrollo/deepseek-harness-web}"

uso() {
  cat <<'AYUDA'
Trae la última versión de upstream y la incorpora a la rama de trabajo mediante
un pull request, regenerando la serie de parches.

  ./local-changes/sync-upstream.sh          prepara la rama de fusión, sin publicar
  ./local-changes/sync-upstream.sh --push   publica, abre el PR y lo fusiona

Sin --push, el script termina imprimiendo las órdenes para publicar y fusionar.
Con conflictos, la fusión se queda a medias: resuélvelos, `git add` y
`git commit`, y vuelve a lanzar este script. Para volver atrás: `git merge --abort`.

Variables: BRANCH (rama de trabajo, por defecto local/custom), UPSTREAM (remoto
del proyecto original, por defecto upstream), UPSTREAM_BRANCH (por defecto
master), DSH_WEB_DIR (carpeta del lanzador instalado).
AYUDA
}

# La copia instalada del lanzador vive fuera del repositorio y no debe quedarse
# atrás cuando cambia la versionada.
refrescar_lanzador() {
  if [ -f "$DSH_WEB_DIR/arrancar-web.sh" ] \
     && [ "$DSH_WEB_DIR/arrancar-web.sh" -ot "$root/local-changes/arrancar-web.sh" ]; then
    cp "$root/local-changes/arrancar-web.sh" "$DSH_WEB_DIR/arrancar-web.sh"
    echo "==> Lanzador instalado refrescado en $DSH_WEB_DIR"
  fi
}

push=0
case "${1:-}" in
  --push) push=1 ;;
  -h|--ayuda) uso; exit 0 ;;
  '') ;;
  *) echo "uso: $0 [--push|--ayuda]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: hay cambios sin commitear; commiteálos o descártalos antes de sincronizar" >&2
  exit 1
fi

echo "==> Descargando $UPSTREAM/$UPSTREAM_BRANCH"
git fetch "$UPSTREAM" --prune

# master es el espejo de upstream: no lleva commits propios y no está sujeto a la
# regla de PR, así que se puede publicar directamente.
if git show-ref --verify --quiet refs/heads/master; then
  if [ "$(git rev-parse --abbrev-ref HEAD)" = master ]; then
    git merge --ff-only "$UPSTREAM/$UPSTREAM_BRANCH"
  else
    git branch -f master "$UPSTREAM/$UPSTREAM_BRANCH" 2>/dev/null \
      || echo "aviso: master no se movió (¿está activa en otro worktree?)" >&2
  fi
fi
if [ "$push" = 1 ]; then
  git push origin master
fi

git checkout "$BRANCH"
rama_sync="sync/upstream-$(date +%Y%m%d-%H%M%S)"
echo "==> Preparando $rama_sync con la fusión de $UPSTREAM/$UPSTREAM_BRANCH"
git checkout -b "$rama_sync"

antes="$(git rev-parse HEAD)"
if ! git merge --no-edit "$UPSTREAM/$UPSTREAM_BRANCH"; then
  cat >&2 <<'EOF'

error: la fusión quedó con conflictos.
  - resuélvelos, `git add` y `git commit`
  - o cancela todo con `git merge --abort`
Tus commits siguen ahí: fusionar no los reescribe.
Vuelve a lanzar este script cuando termines.
EOF
  exit 1
fi

if [ "$(git rev-parse HEAD)" = "$antes" ]; then
  echo "==> Nada nuevo en $UPSTREAM/$UPSTREAM_BRANCH; no hay PR que abrir"
  git checkout "$BRANCH"
  git branch -D "$rama_sync" >/dev/null
  refrescar_lanzador
  exit 0
fi

"$root/local-changes/export-patches.sh"
if [ -n "$(git status --porcelain -- local-changes/patches)" ]; then
  git add local-changes/patches
  git commit -m "chore(local-changes): regenerar la serie de parches" >/dev/null
  echo "==> Serie de parches regenerada en un commit nuevo"
fi

if [ "$push" != 1 ]; then
  echo "==> Rama lista y sin publicar. Para incorporarla:"
  echo "      git push -u origin $rama_sync"
  echo "      gh pr create --base $BRANCH --head $rama_sync --fill"
  echo "      gh pr merge --merge --delete-branch"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: hace falta gh para publicar la rama, abrir el PR y fusionarlo" >&2
  exit 1
fi

# El slug del repositorio se deriva del remoto: las versiones antiguas de gh no
# sustituyen los marcadores {owner}/{repo} de forma fiable.
slug="$(git remote get-url origin)"
slug="${slug#git@github.com:}"
slug="${slug#https://github.com/}"
slug="${slug%.git}"

echo "==> Publicando $rama_sync"
git push -u origin "$rama_sync"

# REST y no `gh pr create`/`gh pr merge`: el GraphQL que usa gh 2.45 consulta el
# campo `hasPullRequests`, que GitHub retiró con los ajustes de PR de 2026, y
# esas órdenes fallan. Los endpoints REST funcionan con cualquier versión.
echo "==> Abriendo el PR contra $BRANCH"
pr="$(gh api -X POST "repos/$slug/pulls" \
  -f title="chore(local-changes): fusionar $UPSTREAM/$UPSTREAM_BRANCH ($(date +%Y-%m-%d))" \
  -f head="$rama_sync" \
  -f base="$BRANCH" \
  -f body="Actualización desde \`$UPSTREAM/$UPSTREAM_BRANCH\`. La rama de trabajo solo acepta cambios por pull request, así que la actualización entra como fusión; la serie de parches se regenera en el mismo PR." \
  --jq .number)"

echo "==> Fusionando el PR #$pr"
git checkout "$BRANCH"
gh api -X PUT "repos/$slug/pulls/$pr/merge" -f merge_method=merge --jq .merged >/dev/null
gh api -X DELETE "repos/$slug/git/refs/heads/$(printf '%s' "$rama_sync" | sed 's|/|%2F|g')" >/dev/null
git pull --ff-only origin "$BRANCH"

refrescar_lanzador
echo "==> Sincronizado. Arranca con: $root/local-changes/arrancar-web.sh"
