# Cambios locales del fork

Esta carpeta guarda los cambios propios de este fork de `deepseek-harness`
sobre el proyecto original, para poder seguir actualizando desde upstream sin
perderlos y sin dejar de recibir las funcionalidades nuevas.

## Cómo está montado

| Remoto | Repositorio | Papel |
| --- | --- | --- |
| `upstream` | `git@github.com:deepseek-ai/deepseek-harness.git` | Proyecto original. Solo lectura. |
| `origin` | `git@github.com:papulo79/deepseek-harness.git` | Tu fork. Aquí se publica todo. |

- `master` es un espejo exacto de `upstream/master`. No lleva cambios propios,
  así que el botón *Sync fork* de GitHub y los PRs contra upstream siguen
  funcionando.
- `local/custom` es la rama de trabajo. Tus cambios viven ahí como commits
  normales encima de `master`.
- `local-changes/patches/` es esa misma serie exportada con `git format-patch`,
  para poder reconstruirla sobre cualquier versión limpia de upstream.

Los cambios incluidos hoy:

- **LAN mobile pairing.** `dsh web --host 0.0.0.0` sirve una página de
  emparejamiento a navegadores móviles de la red local: la página canjea un PIN
  de seis dígitos, generado en el proceso, por la cookie de sesión firmada que
  ya usa el enlace de lanzamiento local. Diseño en
  `local-changes/docs/2026-09-10-web-lan-access-design.md`, plan en
  `local-changes/docs/2026-09-10-web-lan-pairing.md` y nota de arquitectura
  en `.agents/notes/implemented/architecture/2026-09-10-lan-mobile-pairing.md`.

## Actualizar desde upstream

```sh
./local-changes/sync-upstream.sh          # descarga, rebasa y regenera la serie
./local-changes/sync-upstream.sh --push   # además publica master y la rama en el fork
```

El script hace, en este orden:

1. se niega a ejecutarse si hay cambios sin commitear;
2. `git fetch upstream --prune`;
3. deja `master` en `upstream/master`;
4. rebasa `local/custom` sobre `upstream/master`;
5. regenera `local-changes/patches/` y lo commitea si cambió.

Si hay conflictos, el rebase queda a medias y el script sale con error:
resuélvelos, haz `git add` y `git rebase --continue`, y vuelve a lanzar el
script para regenerar la serie. Para volver atrás, `git rebase --abort`.

Si upstream absorbe un cambio tuyo, el rebase lo detectará como vacío:
sáltalo con `git rebase --skip` y borra su entrada de la lista de arriba.

Después de sincronizar conviene reconstruir:

```sh
pnpm install && pnpm run build
```

## Reconstruir los cambios sobre una copia limpia

`apply-patches.sh` aplica la serie completa sobre el commit en el que estés, y
localiza los parches por su propia ruta. Sirve para partir de upstream recién
descargado en vez de tu rama. Copia la carpeta fuera del repositorio antes de
cambiar de rama: `local-changes/` está versionada en `local/custom`, así que el
`checkout` la borraría.

```sh
cp -r local-changes /tmp/local-changes
git fetch upstream
git checkout -b intento upstream/master
/tmp/local-changes/apply-patches.sh
```

Aplica con `git am --3way`, que resuelve solo los solapes triviales. Si un
parche falla, `git am` deja el conflicto en el árbol: resuélvelo, `git add` y
`git am --continue`; para cancelar, `git am --abort`.

## Añadir un cambio nuevo

```sh
git checkout local/custom
# ... editas ...
git add -A && git commit -m "feat(area): descripción"
./local-changes/sync-upstream.sh --push
```

El último paso regenera `local-changes/patches/` con el commit nuevo, lo
commitea y publica la rama. No hace falta tocar los parches a mano.

## Relación con la carpeta externa `deepseek-harness-web/`

El lanzador y sus notas viven fuera del repositorio, en
`~/Desarrollo/deepseek-harness-web/`. Ahí sigue un `lan-movil.patch` de 37
ficheros y 895 líneas: es una **iteración anterior** del mismo cambio, ya
sustituida por `local-changes/patches/` (40 ficheros, 1247 líneas). No lo borres
sin más: `arrancar-web.sh` lo usa como último recurso.

El lanzador decide si el cambio está aplicado con `cambio_presente()`, que
comprueba dos cadenas: que `web-app/src/startup.ts` ya no diga `intentionally
not supported yet` y que `browser-auth.ts` contenga `authorizePairing`.

**El riesgo que introduce la rama.** Si el repositorio está en `master` —espejo
limpio de upstream, sin el cambio—, el lanzador antiguo lo considera ausente y
aplica `lan-movil.patch` **sobre master**, lo que ensucia el espejo y te deja
ejecutando la versión vieja sin avisar. `local-changes/arrancar-web.sh` corrige
esto: si el cambio falta y existe la rama `local/custom` con el árbol limpio,
hace `checkout` de esa rama en vez de parchear, y se niega a parchear `master`
mientras esa rama exista. Cuando no existe —un clon recién hecho— sí aplica
parches sobre `master`, que es la única vía. Prefiere la serie versionada del
repositorio sobre la copia suelta y la aplica **entera**, no solo el primer
parche.

## Instalar el lanzador

El lanzador **ya está en el repositorio**: [`arrancar-web.sh`](arrancar-web.sh) es
la fuente de verdad. Lo que vive fuera es la *instalación*, y conviene que sea
así: `local-changes/` solo existe en `local/custom`, de modo que una copia dentro
del repositorio desaparece en cuanto el árbol queda en `master` —justo cuando
más falta hace para volver a la rama.

Instálalo, o actualízalo tras cambiarlo, con:

```sh
cp local-changes/arrancar-web.sh ~/Desarrollo/deepseek-harness-web/arrancar-web.sh
```

También puedes ejecutarlo directamente desde el repositorio, sin instalar nada:

```sh
./local-changes/arrancar-web.sh
```

En ese caso la huella de compilación vive en `$REPO/.artifacts/`, que git
ignora, así que no ensucia el árbol. `DSH_REPO` o `--repo` apuntan a otro
checkout, y `DSH_SELLO` a otra huella.

Un detalle esperado: la huella incluye el commit y el estado de git, así que el
primer arranque tras cualquier commit reconstruye una vez (`pnpm run build`)
aunque el código sea idéntico.

## Reglas para convivir con los gates del repositorio

- **Ningún `README.md` en esta carpeta.** El gate `verify-translation-pairing`
  trata cualquier fichero llamado `README.md` como documentación de producto y
  exige su pareja en chino y su registro. Por eso este documento se llama
  `GUIDE.md`.
- **`local-changes/` queda fuera de la serie de parches**, por decisión
  explícita en `export-patches.sh`: es infraestructura del fork, no un cambio de
  producto. La carpeta viaja igualmente en los commits de la rama.
- **`.gitattributes` propio de la carpeta.** `local-changes/.gitattributes`
  desactiva el chequeo de espacios para `patches/*.patch`: las líneas de
  contexto de un diff unificado empiezan por un espacio que es formato, no
  contenido, y `git diff --check` las marcaría como error. Así el
  `.gitattributes` de la raíz no se toca.
- **Los planes y specs viven en `local-changes/docs/`, no en `docs/`.** El árbol
  `docs/` es documentación de producto y sus gates (`doc-typecheck`,
  `verify-translation-pairing`) exigen que todo lo que hay ahí compile y tenga
  pareja en chino. Sacarlos de ahí deja los gates limpios **sin modificar
  ningún fichero de upstream**.

## Ficheros de esta carpeta

| Fichero | Para qué sirve |
| --- | --- |
| `GUIDE.md` | Este documento. |
| `.gitattributes` | Exime a `patches/*.patch` del chequeo de espacios. |
| `docs/` | Diseño, plan y guía de uso del cambio de LAN pairing, fuera de los gates de producto. |
| `sync-upstream.sh` | Trae upstream, rebasa la rama y regenera la serie. |
| `export-patches.sh` | Regenera `patches/` desde los commits de la rama actual. |
| `apply-patches.sh` | Aplica `patches/` sobre el commit actual. |
| `arrancar-web.sh` | Copia versionada del lanzador web; cópiala sobre la de `deepseek-harness-web/`. |
| `patches/*.patch` | La serie de cambios, en orden. |
