#!/usr/bin/env bash
# Aplica la serie de parches locales sobre el commit en el que estés.
#
#   cp -r local-changes /tmp/local-changes     # cambiar de rama borraría la carpeta
#   git fetch upstream
#   git checkout -b intento upstream/master
#   /tmp/local-changes/apply-patches.sh
#
# Localiza los parches por la ruta de este propio script, así que funciona
# invocado desde cualquier sitio mientras la carpeta siga existiendo.
# Usa `git am --3way`, que resuelve solo los solapes triviales. Ante un
# conflicto, `git am` deja el estado en el árbol: resuélvelo, `git add` y
# `git am --continue`; para cancelar, `git am --abort`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git rev-parse --show-toplevel)"
cd "$root"

# Una copia sin commitear de local-changes/ no es un cambio del árbol que deba
# bloquear la aplicación; los cambios reales fuera de la carpeta sí.
if [ -n "$(git status --porcelain -- . ':(exclude)local-changes')" ]; then
  echo "error: hay cambios sin commitear; commiteálos o descártalos antes de aplicar" >&2
  exit 1
fi

patches=()
while IFS= read -r patch; do
  patches+=("$patch")
done < <(find "$here/patches" -maxdepth 1 -name '*.patch' | sort)
if [ "${#patches[@]}" = 0 ]; then
  echo "error: no hay parches en $here/patches" >&2
  exit 1
fi

echo "==> Aplicando ${#patches[@]} parche(s) sobre $(git rev-parse --short HEAD)"
git am --3way "${patches[@]}"

echo "==> Aplicados. Reconstruye con: pnpm install && pnpm run build"
