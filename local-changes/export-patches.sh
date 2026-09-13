#!/usr/bin/env bash
# Regenera local-changes/patches a partir de los commits de una rama.
#
#   ./local-changes/export-patches.sh
#
# Variables de entorno: BRANCH (rama a exportar; por defecto la actual),
# UPSTREAM (remoto del proyecto original), UPSTREAM_BRANCH (rama de referencia).
set -euo pipefail

BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
UPSTREAM="${UPSTREAM:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"

root="$(git rev-parse --show-toplevel)"
cd "$root"
base="$UPSTREAM/$UPSTREAM_BRANCH"

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "error: no existe $base; ejecuta 'git fetch $UPSTREAM' primero" >&2
  exit 1
fi

mkdir -p local-changes/patches
rm -f local-changes/patches/*.patch

if [ "$(git rev-list --count "$base..$BRANCH")" = 0 ]; then
  echo "aviso: $BRANCH no tiene commits sobre $base; no hay parches que exportar" >&2
  exit 0
fi

# local-changes/ es infraestructura del fork, no parte del cambio de producto:
# excluirla evita que la serie se reescriba a sí misma al aplicarla. Los commits
# de fusión tampoco entran: la serie es el cambio de producto, no el historial.
git format-patch --binary --no-signature --zero-commit --no-merges \
  -o local-changes/patches "$base..$BRANCH" -- . ':(exclude)local-changes' >/dev/null

echo "==> $(find local-changes/patches -name '*.patch' | wc -l) parche(s) en local-changes/patches"
