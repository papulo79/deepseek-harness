# Usar DeepSeek Harness desde el móvil (red local)

Esta guía describe cómo arrancar el harness exponiéndolo en la red local y emparejar un móvil con el PIN temporal. El soporte de `--host 0.0.0.0` y del emparejamiento LAN es un cambio de este fork, todavía no upstream: vive en la rama `local/custom`. La guía canónica del fork es [`../GUIDE.md`](../GUIDE.md).

## Arranque rápido

El lanzador está fuera del repositorio, en `~/Desarrollo/deepseek-harness-web/arrancar-web.sh` (su copia versionada es [`../arrancar-web.sh`](../arrancar-web.sh)). Comprueba que el cambio esté presente, recompila si detecta cambios en fuentes, lockfile o commit, verifica que no haya otro `dsh web` en marcha y arranca el servicio:

```sh
~/Desarrollo/deepseek-harness-web/arrancar-web.sh
```

Opciones útiles:

```sh
./arrancar-web.sh --puerto 3081      # otro puerto
./arrancar-web.sh --abrir            # abre también el navegador del ordenador
./arrancar-web.sh --solo-build       # compila si hace falta y no arranca
./arrancar-web.sh --sin-build        # arranca sin comprobar la compilación
./arrancar-web.sh --ayuda            # ayuda completa
```

El lanzador guarda la huella de la última compilación en `.build-stamp` y solo recompila cuando cambia `git HEAD`, el estado de los ficheros con seguimiento o `pnpm-lock.yaml`, o cuando faltan los artefactos.

## Un solo servidor (importante)

El harness mantiene **un único escritor por sesión**, con un bloqueo de fichero a nivel de kernel (`session.lock`, `flock`) que actúa **entre procesos**. Dos procesos `dsh web` que compartan `$DSH_HOME` ven la misma lista de sesiones, pero solo el proceso que activa una sesión puede escribirla; el otro falla al abrirla:

```
resume failed for session "session-...": SessionAlreadyOwnedError:
session "session-..." is already owned by an active write handle (gateway/internal)
```

Síntoma típico en el móvil: la lista y parte de la interfaz cargan, pero no se puede abrir la sesión activa y el selector de modelo u otros datos ligados a esa sesión quedan vacíos o dan error.

La solución es usar **un único** `dsh web --host 0.0.0.0` para los dos dispositivos:

- Escritorio: abre la URL loopback con token que imprime el arranque.
- Móvil: abre la URL LAN e introduce el PIN.

Comprueba que no queda otro servidor escuchando:

```sh
ss -ltnp | grep -E ':(3080|3081|3082)'
```

Si aparece más de un puerto, detén el servidor antiguo con `Ctrl+C` antes de arrancar el nuevo. `arrancar-web.sh` detecta este caso y se niega a arrancar salvo que pases `--permitir-multi`.

## Requisitos

- Node en el rango soportado (`^22.19 || >=24`) y dependencias instaladas (`pnpm install`).
- Artefactos construidos. El lanzador los construye si faltan o si detecta cambios; en manual, `pnpm run build`.
- El móvil en la misma red local que el ordenador.

## Arranque manual

Desde la raíz del repositorio:

```sh
pnpm dsh web --host 0.0.0.0 --port 3081 --no-open
```

Equivalente con el perfil explícito:

```sh
pnpm dsh --profile web --host 0.0.0.0 --port 3081 --no-open
```

`--host 0.0.0.0` es el opt-in explícito que abre todas las interfaces. Sin ese flag el servidor escucha solo en `127.0.0.1`. `--port` elige el puerto (por defecto 3080; `0` deja que el sistema operativo elija uno libre). `--no-open` evita que se abra el navegador del ordenador; puedes omitirlo si quieres que además se abra en local.

La línea de arranque tiene este aspecto:

```
dsh web: http://127.0.0.1:3081/?token=... (LAN: http://192.168.1.5:3081; pairing PIN: 123456)
```

- La primera URL es la local, con el token de proceso; sirve para el navegador del propio ordenador.
- El bloque `(LAN: ...; pairing PIN: ...)` es el que usa el móvil: URL limpia (sin token) y PIN de seis dígitos.

Si no aparece el bloque `LAN`, el servidor escuchó en loopback o no encontró ninguna IPv4 **privada**; revisa `--host 0.0.0.0` y la conexión de red. Una interfaz con dirección pública no recibe formulario de emparejamiento ni se anuncia, para no exponer el PIN fuera de la red local.

## Emparejar el móvil

1. Abre en el móvil la URL `http://<IP-LAN>:<PUERTO>` que aparece en el bloque `LAN`.
2. La primera visita muestra una página mínima de emparejamiento. Escribe el PIN de seis dígitos y envía el formulario.
3. El servidor responde con una cookie de sesión firmada y ligada a esa authority, y te redirige a la raíz limpia. A partir de ahí el móvil funciona como el navegador local.

El PIN vive solo en memoria y cambia al reiniciar el proceso. Tras cinco intentos fallidos desde la misma dirección de origen, esa dirección queda bloqueada cinco minutos; y cuando se agotan los 50 intentos fallidos de **todos** los pares juntos, el emparejamiento se detiene hasta reiniciar el proceso, para que rotar direcciones no dé conjeturas ilimitadas. El aviso aparece en la consola del servidor.

## Seguridad y límites

- No hay TLS. El PIN y la cookie de sesión viajan en claro por la red local. Úsalo solo en una red privada de confianza; si la red no es de confianza, limita el puerto con el cortafuegos del ordenador.
- El cambio no añade exposición a Internet, proxy inverso ni autenticación más allá de la sesión de navegador existente.
- Las direcciones LAN se muestrean una sola vez al arrancar. Si cambia la red o la IP, reinicia el proceso para volver a anunciar la URL y generar un PIN nuevo.

## Problemas frecuentes

- **`SessionAlreadyOwnedError` al abrir una sesión en el móvil.** Hay otro proceso `dsh web` que ya la tiene activa. Detén el otro servidor y usa uno solo para escritorio y móvil (ver «Un solo servidor»).
- **El selector de modelo o partes de la configuración salen vacíos.** Normalmente es consecuencia de lo anterior: al no poder activar la sesión, no cargan los datos ligados a ella. Si persiste con un único servidor, comprueba que el proceso tiene credenciales: el harness las lee del entorno heredado, de `$DSH_HOME/.credentials.yaml`, del `.env` del directorio de invocación y de `$DSH_HOME/.env`. Arranca el servidor desde el mismo shell donde funcionaba antes.
- **El móvil no carga la URL.** Comprueba que la IP impresa es la de la interfaz activa y que el cortafuegos permite el puerto.
- **La página de emparejamiento no aparece y sale un 401.** Estás entrando por un Host que no es una de las direcciones LAN privadas detectadas (por ejemplo, un nombre DNS, `localhost` o una dirección pública). Usa la IP literal impresa.
- **El PIN se rechaza repetidamente.** Tras cinco fallos la dirección queda bloqueada cinco minutos; si la consola avisa de que el presupuesto del proceso se agotó, reinicia el proceso para obtener un PIN nuevo.
- **Quiero la IP a mano.** `ip -4 addr` en Linux, `ipconfig` en Windows, o `ifconfig`/`ipconfig getifaddr en0` en macOS.
