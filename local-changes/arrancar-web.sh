#!/usr/bin/env bash
#
# Arranca DeepSeek Harness en modo red local (móvil) desde esta copia del repo.
#
# - Si el cambio LAN no está en el árbol, cambia a la rama local/custom, que es
#   donde vive versionado; solo reaplica la serie de parches si esa rama no existe.
# - Nunca aplica el parche sobre master, que se mantiene como espejo de upstream.
# - Recompila solo cuando cambian las fuentes, el lockfile o el commit de git.
# - Evita arrancar un segundo `dsh web` sobre el mismo $DSH_HOME (bloqueo de sesión).
# - Deduce la raíz del repositorio de su propia ubicación; --repo y DSH_REPO la
#   sobrescriben para apuntar a otro checkout.
# - Lanza `dsh web --host 0.0.0.0 --port <puerto>`, que imprime la URL LAN y el PIN.
#
# Origen: copia versionada en el repo del lanzador que vivía suelto en
# ~/Desarrollo/deepseek-harness-web/arrancar-web.sh. Cópialo sobre aquel para
# actualizarlo; ver local-changes/GUIDE.md.
#
set -euo pipefail

DIR_SCRIPT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# La raíz se deduce de dónde vive el script —dentro del repo, en local-changes/—
# para que el lanzador sirva en cualquier máquina sin pasar --repo. La copia
# instalada fuera del repositorio no puede deducirla y conserva la ruta conocida
# como último recurso.
REPO_CONOCIDO="/home/reverendo/Desarrollo/deepseek-harness"
REPO_DEDUCIDO="$(git -C "$DIR_SCRIPT" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_DEDUCIDO" ] || [ ! -f "$REPO_DEDUCIDO/local-changes/arrancar-web.sh" ]; then
  REPO_DEDUCIDO="$REPO_CONOCIDO"
fi
REPO="${DSH_REPO:-$REPO_DEDUCIDO}"
BRANCH="${BRANCH:-local/custom}"
UPSTREAM="${UPSTREAM:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
PNPM="${PNPM:-pnpm}"

HOST="0.0.0.0"
PUERTO="3081"
HACER_BUILD=1
SOLO_BUILD=0
APLICAR_PARCHE=1
ABRIR=0
PERMITIR_MULTI=0
AVISAR=1

# Puertos habituales de `dsh web`; dos procesos que compartan $DSH_HOME compiten
# por el bloqueo de escritura de cada sesión (session.lock).
PUERTOS_DSH=(3080 3081 3082)

log() { printf 'arrancar-web: %s\n' "$*"; }
error() { printf 'arrancar-web: ERROR: %s\n' "$*" >&2; }

uso() {
  cat <<'AYUDA'
Arranca DeepSeek Harness en modo red local (móvil) desde esta copia del repo.

Opciones:
  -p, --puerto N     puerto de escucha (por defecto 3081)
      --host H       interfaz de escucha (por defecto 0.0.0.0)
      --repo RUTA    raíz del repositorio (por defecto $DSH_REPO, la raíz donde
                     vive este script, o la ruta conocida)
      --abrir        abre también el navegador del ordenador (omite --no-open)
      --sin-build    no comprueba ni ejecuta la compilación
      --solo-build   compila si hace falta y termina, sin arrancar el servicio
      --sin-parche   no intenta reaplicar la serie de parches
      --sin-avisos   no consulta los remotos para avisar de cambios pendientes
      --permitir-multi
                     arranca aunque ya haya otro `dsh web` escuchando (puede
                     provocar SessionAlreadyOwnedError en las sesiones activas)
  -h, --ayuda        muestra esta ayuda

Variables: DSH_REPO (raíz del repositorio), DSH_PARCHE (parche a reaplicar),
BRANCH (rama de trabajo, por defecto local/custom), UPSTREAM (remoto del proyecto
original, por defecto upstream), PNPM (ejecutable de pnpm).
AYUDA
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--puerto) PUERTO="${2:-}"; [ -n "$PUERTO" ] || { error "falta el valor de $1"; exit 2; }; shift 2 ;;
    --host) HOST="${2:-}"; [ -n "$HOST" ] || { error "falta el valor de $1"; exit 2; }; shift 2 ;;
    --repo) REPO="${2:-}"; [ -n "$REPO" ] || { error "falta el valor de $1"; exit 2; }; shift 2 ;;
    --abrir) ABRIR=1; shift ;;
    --sin-build) HACER_BUILD=0; shift ;;
    --solo-build) SOLO_BUILD=1; shift ;;
    --sin-parche) APLICAR_PARCHE=0; shift ;;
    --sin-avisos) AVISAR=0; shift ;;
    --permitir-multi) PERMITIR_MULTI=1; shift ;;
    -h|--ayuda) uso; exit 0 ;;
    *) error "opción desconocida: $1"; uso; exit 2 ;;
  esac
done

# `-e` y no `-d`: en un worktree `.git` es un fichero que apunta al repositorio
# principal, y el lanzador funciona igual desde ahí.
if [ ! -e "$REPO/.git" ]; then
  error "no encuentro un repositorio git en $REPO (usa --repo o DSH_REPO)"
  exit 1
fi

# La huella de la última compilación vive en el árbol ignorado del repositorio,
# no junto al script: así la copia versionada puede ejecutarse en su sitio sin
# ensuciar el árbol, y la copia instalada fuera comparte el mismo estado.
SELLO="${DSH_SELLO:-$REPO/.artifacts/arrancar-web.stamp}"

STARTUP="$REPO/packages/bundle/web-app/src/startup.ts"
AUTH="$REPO/packages/client/connection/src/browser-auth.ts"

# La serie versionada del propio repo manda sobre la copia suelta de esta
# carpeta: una sola fuente de verdad para el cambio, y se aplica entera.
PARCHES=()
if [ -n "${DSH_PARCHE:-}" ]; then
  PARCHES=("$DSH_PARCHE")
elif compgen -G "$REPO/local-changes/patches/*.patch" >/dev/null 2>&1; then
  while IFS= read -r parche; do
    PARCHES+=("$parche")
  done < <(ls "$REPO"/local-changes/patches/*.patch | sort)
elif [ -f "$DIR_SCRIPT/lan-movil.patch" ]; then
  PARCHES=("$DIR_SCRIPT/lan-movil.patch")
fi

# El cambio está presente cuando el CLI deja de rechazar 0.0.0.0 y Connection
# expone el emparejamiento.
cambio_presente() {
  if grep -q 'intentionally not supported yet' "$STARTUP" 2>/dev/null; then
    return 1
  fi
  grep -q 'authorizePairing' "$AUTH" 2>/dev/null
}

rama_actual() { git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '?'; }
arbol_limpio() { [ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; }

# Desde que el cambio vive en la rama de trabajo, lo normal no es reaplicar el
# parche sino cambiarse a esa rama. Solo se parchea si la rama no existe.
if ! cambio_presente && [ "$APLICAR_PARCHE" = 1 ]; then
  rama="$(rama_actual)"
  if [ "$rama" != "$BRANCH" ] \
     && git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" \
     && arbol_limpio; then
    log "el cambio LAN no está en «$rama»; cambiando a la rama $BRANCH"
    git -C "$REPO" checkout "$BRANCH"
  fi
fi

if cambio_presente; then
  log "cambio LAN presente"
elif [ "$APLICAR_PARCHE" = 1 ] && [ "${#PARCHES[@]}" != 0 ]; then
  # `master` solo se protege donde existe la rama que lleva el cambio: en un
  # clon sin ella, parchear master es la única vía y es lo que este lanzador
  # hacía siempre.
  if [ "$(rama_actual)" = master ] && arbol_limpio \
     && git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    error "«master» es un espejo de upstream y no debe acumular cambios locales"
    error "usa la rama que ya contiene el cambio: git -C \"$REPO\" checkout $BRANCH"
    exit 1
  fi
  log "el cambio LAN no está aplicado; reaplicando ${#PARCHES[@]} parche(s)"
  for parche in "${PARCHES[@]}"; do
    if ! git -C "$REPO" apply --3way "$parche"; then
      error "$(basename "$parche") no se aplica limpio; el árbol puede quedar a medias"
      error "vuelve atrás con: git -C \"$REPO\" checkout -- . && git -C \"$REPO\" clean -fd"
      error "guía: $DIR_SCRIPT/reaplicar-cambio-lan.md"
      exit 1
    fi
  done
  if ! cambio_presente; then
    error "los parches se aplicaron pero el cambio LAN sigue sin detectarse"
    exit 1
  fi
  log "serie reaplicada"
else
  error "el cambio LAN no está aplicado y no hay serie que reaplicar (--sin-parche o parches ausentes)"
  exit 1
fi

# Consulta los remotos y avisa, sin bloquear nunca el arranque, del trabajo
# pendiente: commits nuevos en upstream (toca rebasar) y desajustes con la rama
# publicada. Un fallo de red o de credenciales deja constancia y sigue.
contar_commits() { git -C "$REPO" rev-list --count "$1" 2>/dev/null || printf '0'; }

consultar_remotos() {
  local remoto
  for remoto in "$UPSTREAM" origin; do
    if command -v timeout >/dev/null 2>&1; then
      timeout 15 git -C "$REPO" fetch --quiet "$remoto" 2>/dev/null || return 1
    else
      git -C "$REPO" fetch --quiet "$remoto" 2>/dev/null || return 1
    fi
  done
}

avisar_de_cambios_pendientes() {
  if ! consultar_remotos; then
    log "no pude consultar los remotos ahora mismo; arranco igual"
    return 0
  fi
  local nuevos sin_publicar sin_bajar
  nuevos="$(contar_commits "$BRANCH..$UPSTREAM/$UPSTREAM_BRANCH")"
  sin_publicar="$(contar_commits "origin/$BRANCH..$BRANCH")"
  sin_bajar="$(contar_commits "$BRANCH..origin/$BRANCH")"
  if [ "$nuevos" != 0 ]; then
    log "AVISO: $UPSTREAM/$UPSTREAM_BRANCH tiene $nuevos commit(s) nuevos; cuando puedas: $REPO/local-changes/sync-upstream.sh"
  fi
  if [ "$sin_publicar" != 0 ]; then
    log "AVISO: tienes $sin_publicar commit(s) sin publicar en $BRANCH"
  fi
  if [ "$sin_bajar" != 0 ]; then
    log "AVISO: origin/$BRANCH tiene $sin_bajar commit(s) que no tienes; haz: git -C \"$REPO\" pull --ff-only"
  fi
  if [ "$nuevos" = 0 ] && [ "$sin_publicar" = 0 ] && [ "$sin_bajar" = 0 ]; then
    log "al día con $UPSTREAM/$UPSTREAM_BRANCH y con origin/$BRANCH"
  fi
}

if [ "$AVISAR" = 1 ]; then
  avisar_de_cambios_pendientes
fi

puerto_en_uso() {
  local puerto="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${puerto}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$puerto" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${puerto}\$"
  else
    return 1
  fi
}

# Un segundo proceso `dsh web` sobre el mismo $DSH_HOME ve las mismas sesiones,
# pero el bloqueo de escritura (flock sobre session.lock) es entre procesos: el
# segundo falla al activar una sesión con SessionAlreadyOwnedError, y el cliente
# deja sin cargar los datos ligados a esa sesión.
comprobar_servidores() {
  if puerto_en_uso "$PUERTO"; then
    error "el puerto $PUERTO ya está escuchando (¿otro dsh web?)"
    [ "$PERMITIR_MULTI" = 1 ] && return 0
    error "detén el servidor anterior o usa --puerto con otro valor libre"
    exit 1
  fi
  local p
  for p in "${PUERTOS_DSH[@]}"; do
    [ "$p" = "$PUERTO" ] && continue
    if puerto_en_uso "$p"; then
      error "hay algo escuchando en el puerto $p: probablemente otro dsh web"
      error "dos procesos dsh web comparten \$DSH_HOME y se bloquean las sesiones activas"
      error "recomendación: detén el otro servidor y usa un único dsh web para escritorio y móvil"
      [ "$PERMITIR_MULTI" = 1 ] && { log "continuando por --permitir-multi"; return 0; }
      error "para forzar el arranque, usa --permitir-multi"
      exit 1
    fi
  done
}

if [ "$SOLO_BUILD" != 1 ]; then
  comprobar_servidores
fi

huella() {
  {
    git -C "$REPO" rev-parse HEAD 2>/dev/null || printf 'sin-git\n'
    git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null || true
    sha256sum "$REPO/pnpm-lock.yaml" 2>/dev/null | cut -d' ' -f1 || true
  } | sha256sum | cut -d' ' -f1
}

artefactos_presentes() {
  [ -f "$REPO/apps/cli/lib/bin.js" ] && [ -f "$REPO/apps/web/dist/index.html" ]
}

if [ "$HACER_BUILD" = 1 ]; then
  actual="$(huella)"
  registrada=""
  [ -f "$SELLO" ] && registrada="$(cat "$SELLO")"

  if ! artefactos_presentes; then
    motivo="faltan artefactos compilados"
  elif [ "$actual" != "$registrada" ]; then
    motivo="cambiaron las fuentes, el lockfile o el commit"
  else
    motivo=""
  fi

  if [ -n "$motivo" ]; then
    log "compilando ($motivo)…"
    if [ ! -d "$REPO/node_modules" ]; then
      log "instalando dependencias…"
      (cd "$REPO" && "$PNPM" install)
    fi
    (cd "$REPO" && "$PNPM" run build)
    mkdir -p "$(dirname "$SELLO")"
    printf '%s\n' "$actual" > "$SELLO"
    log "compilación completada"
  else
    log "artefactos al día; no hace falta compilar"
  fi
else
  log "comprobación de compilación desactivada (--sin-build)"
fi

if [ "$SOLO_BUILD" = 1 ]; then
  log "solo compilación solicitada; no se arranca el servicio"
  exit 0
fi

args=(web --host "$HOST" --port "$PUERTO")
if [ "$ABRIR" = 0 ]; then
  args+=(--no-open)
fi

log "arrancando «$PNPM dsh ${args[*]}» en $REPO"
log "escritorio: abre la URL loopback con token que imprime el arranque"
log "móvil: abre la URL LAN e introduce el PIN: (LAN: http://<IP>:<PUERTO>; pairing PIN: <6 dígitos>)"
cd "$REPO"
exec "$PNPM" dsh "${args[@]}"
