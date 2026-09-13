#!/usr/bin/env bash
# Actualiza el fork con la última versión del proyecto original: descarga,
# rebasa la rama de trabajo encima y regenera la serie de parches.
#
#   ./local-changes/sync-upstream.sh          # solo local
#   ./local-changes/sync-upstream.sh --push   # además publica master y la rama
#   ./local-changes/sync-upstream.sh --ayuda
#
# Es la única vía de actualización. El botón «Sync fork» de GitHub, sobre esta
# rama, no es un rebase: ofrece descartar los commits propios.
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
Trae la última versión de upstream, rebasa la rama de trabajo y regenera la
serie de parches.

  ./local-changes/sync-upstream.sh          descarga, rebasa y regenera parches
  ./local-changes/sync-upstream.sh --push   además publica master y la rama

Con conflictos, el rebase se queda a medias: resuélvelos, `git add` y
`git rebase --continue`, y vuelve a lanzar este script para regenerar los
parches. Para volver atrás: `git rebase --abort`.

Variables: BRANCH (rama de trabajo, por defecto local/custom), UPSTREAM (remoto
del proyecto original, por defecto upstream), UPSTREAM_BRANCH (por defecto
master), DSH_WEB_DIR (carpeta del lanzador instalado).
AYUDA
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

# master se mantiene como espejo exacto de upstream: es lo que hace que
# actualizar sea rebasar los commits propios y no fusionarlos.
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
Tus commits siguen ahí: el rebase los recoloca, no los borra.
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
  # La rama rebasada tiene hashes nuevos: el lease aborta si el remoto se movió.
  git push --force-with-lease origin "$BRANCH"
fi

# La copia instalada del lanzador vive fuera del repositorio y no debe quedarse
# atrás cuando cambia la versionada.
if [ -f "$DSH_WEB_DIR/arrancar-web.sh" ] \
   && [ "$DSH_WEB_DIR/arrancar-web.sh" -ot "$root/local-changes/arrancar-web.sh" ]; then
  cp "$root/local-changes/arrancar-web.sh" "$DSH_WEB_DIR/arrancar-web.sh"
  echo "==> Lanzador instalado refrescado en $DSH_WEB_DIR"
fi

echo "==> Sincronizado. Arranca con: $root/local-changes/arrancar-web.sh"
