# Aquiles

Agente personal para Windows, Mac y Linux con app de escritorio. Trabaja con tus ficheros y tu terminal, recuerda lo que aprende y puede ejecutar tareas por su cuenta. Tiene dos partes:
- el **núcleo**, que es el agente, en TypeScript sobre Bun;
- la **app**, en Tauri 2 y React.

Es un proyecto personal: lo hago para mi propio uso y no hay soporte. El código es público bajo la licencia MIT (ver [Licencia](#licencia)).

## Qué hace

- **Conversación con herramientas:** leer, buscar, editar y crear ficheros; terminal persistente (local, en un contenedor Docker o por SSH); búsqueda y lectura de webs; control de Edge (desactivado por defecto); servidores MCP.
- **Adjuntos:** imágenes y documentos (PDF, Word, Excel, PowerPoint, texto y código). Se sacan su texto y las imágenes las ven los modelos que las admiten. Los ficheros de la carpeta de trabajo también se pueden mencionar con `@` en el mensaje.
- **Imágenes:** `generar_imagen` las crea con agy (Antigravity, Nano Banana) o Codex con tu sesión, o con una clave de Gemini, OpenAI u OpenRouter; se guardan en la carpeta y se ven en el panel.
- **Artefactos:** páginas HTML, SVG, documentos y ficheros de código que el modelo escribe aparte. Se ven mientras los escribe y luego se renderizan en una vista aislada.
- **Permisos:** escribe sin preguntar dentro de la carpeta de trabajo y pregunta antes de ejecutar comandos. También se puede elegir «preguntar siempre» o «libre en el proyecto». Hay un guardián opcional: un modelo que aprueba lo claramente seguro.
- **Auditoría y deshacer:** cada sesión guarda un registro de las herramientas que se usaron (quién las aprobó, si salieron bien) y una copia de los ficheros antes de cambiarlos; en «Cambios» se ve por turno qué ficheros tocó y se puede deshacer. Lo que hace la terminal queda en el registro, pero no se puede deshacer.
- **Memoria y skills:** memoria corta del usuario, del agente y de cada proyecto, más una personalidad editable; skills en formato `SKILL.md`; búsqueda de texto en todas las conversaciones.
- **Aprendizaje:** una revisión en segundo plano propone qué recordar de cada conversación, y tú aceptas o descartas. Todo lo aprendido queda registrado con su sesión de origen. Las skills aprendidas que no se usan se archivan, sin borrarse.
- **Subagentes:** reparte trabajo independiente entre varias instancias de Aquiles que trabajan en paralelo. Desde un panel se pueden seguir, reconducir y parar.
- **Automatizaciones:**
  - tareas programadas («cada lunes 9:00», «en 30m» o cron) que entregan el resultado en el escritorio, Telegram, Discord, Slack o por correo;
  - conversación desde esos chats;
  - objetivos con un juez que decide si el trabajo está acabado.
- **Modelos:**
  - los CLI de Antigravity (`agy`), Claude Code (`claude`) y Codex (`codex`), con la cuenta en la que hayas iniciado sesión;
  - Anthropic, OpenAI y OpenRouter con clave de API;
  - Ollama y LM Studio en local;
  - modelos GGUF de Hugging Face, que se buscan, se descargan y se ejecutan con llama.cpp.

  El nivel de esfuerzo de razonamiento se puede elegir en los modelos que lo declaran.
- **Idioma:** la interfaz está en español (por defecto) o en inglés, en Ajustes → General. Los mensajes del núcleo siguen en español; el modelo contesta en el idioma en que le escribas.
- **Aplicación:**
  - bandeja del sistema y arranque al iniciar sesión;
  - atajo global con entrada rápida;
  - perfiles, copias de seguridad y restauración;
  - voz con lo que trae cada sistema: dictado continuo (el micrófono de la caja escucha frase tras frase) y lectura en voz alta; en Windows con System.Speech, en Mac con el reconocedor de voz de macOS y `say`, y en Linux con Vosk (se instala desde Ajustes, sin conexión) y `espeak-ng` o Speech Dispatcher;
  - estadísticas;
  - modo remoto (la app conectada a un núcleo en otra máquina);
  - integración con editores por ACP (`aquiles-nucleo --acp`).

## Instalación

En PowerShell, clona el repositorio y ejecuta el instalador. Hace falta Git (`winget install -e --id Git.Git`). Si el repositorio es privado, `git` te pedirá la primera vez una cuenta de GitHub que tenga acceso.

```powershell
git clone https://github.com/evilrender23/Aquiles.git
powershell -ExecutionPolicy Bypass -File Aquiles\instalar.ps1
```

Si el repositorio es público, basta con una línea:

```powershell
irm https://raw.githubusercontent.com/evilrender23/Aquiles/main/instalar.ps1 | iex
```

El script hace tres cosas:
1. Comprueba los requisitos: Git, Bun, Rust con el toolchain MSVC, Visual Studio Build Tools con C++ y WebView2. Si falta alguno, pregunta antes de instalarlo con winget.
2. Descarga la rama `main` en `%LOCALAPPDATA%\Aquiles\codigo`.
3. La compila, la instala en `%LOCALAPPDATA%\Aquiles\app` y crea un acceso directo en el menú Inicio.

La app se mantiene al día sola: cuando `main` tiene commits nuevos, los compila en segundo plano y los aplica al reiniciarla. También se puede actualizar a mano:
- desde el aviso que aparece en la barra lateral cuando hay versión nueva;
- con «Buscar actualizaciones» en el icono de la bandeja;
- en Ajustes → Aplicación.

Una copia suelta de la app (sin instalar) ofrece ahí «Instalar con actualizaciones».

### En Mac

En la Terminal, clona el repositorio y ejecuta el instalador:

```bash
git clone https://github.com/evilrender23/Aquiles.git
bash Aquiles/instalar.sh
```

Si el repositorio es público, basta con una línea:

```bash
curl -fsSL https://raw.githubusercontent.com/evilrender23/Aquiles/main/instalar.sh | bash
```

Hace lo mismo que en Windows:
1. Comprueba los requisitos: las herramientas de línea de comandos de Xcode (traen Git), Bun y Rust. Si falta alguno, pregunta antes de instalarlo.
2. Descarga la rama `main` en `~/Library/Application Support/Aquiles/codigo`.
3. La compila y la instala en `/Applications/Aquiles.app` (en `~/Applications` si no se puede escribir en `/Applications`).

Se actualiza sola igual que en Windows. Opciones: `--repo`, `--rama`, `--destino` y `--app`.

Para compilarla sin instalar: `bun run app:mac` deja `Aquiles.app` y un `.dmg` en `apps/escritorio/src-tauri/target/release/bundle/` para la arquitectura de ese Mac; `bun run app:mac:universal`, una sola app para Apple Silicon e Intel (en `target/universal-apple-darwin/`). Va firmada solo en local (ad hoc), así que en otro Mac hay que abrirla la primera vez con clic derecho → Abrir. Con una cuenta de desarrollador de Apple, define `APPLE_SIGNING_IDENTITY` (y `APPLE_ID`, `APPLE_PASSWORD` y `APPLE_TEAM_ID` para notarizarla) antes de compilar: Tauri la firma y la notariza.

El dictado de Mac es un pequeño programa en Swift (`apps/escritorio/src-tauri/macos/dictado.swift`) que el instalador compila dentro de la app. La primera vez que dictas, macOS pide permiso para el micrófono y el reconocimiento de voz.

En Mac no hay todavía:
- instalación automática de llama.cpp y Docker (si ya están en el PATH, se usan).

El núcleo recibe el PATH de tu shell (`~/.zshrc` y compañía), así que encuentra `claude`, `codex`, `agy` y lo de Homebrew aunque abras la app desde el Dock. El control del navegador usa Microsoft Edge si está en Aplicaciones. Los datos van en `~/.config/Aquiles`.

### En Linux

Igual que en Mac, con el mismo instalador:

```bash
git clone https://github.com/evilrender23/Aquiles.git
bash Aquiles/instalar.sh
```

1. Comprueba los requisitos: un compilador de C, Git, curl, las bibliotecas de desarrollo de GTK, WebKitGTK 4.1 y D-Bus, Bun y Rust. Si falta algo, pregunta antes de instalarlo; las bibliotecas, con el gestor de paquetes de la distribución (apt, dnf, pacman o zypper) y `sudo`.
2. Descarga la rama `main` en `~/.local/share/Aquiles/codigo`.
3. La compila y la deja en `~/.local/share/Aquiles/app`, con un lanzador en el menú de aplicaciones.

Se actualiza sola igual que en Windows y Mac. Opciones: `--repo`, `--rama` y `--destino`.

Para hacer paquetes: `bun run app:linux` deja un `.deb` y un `.rpm` en `apps/escritorio/src-tauri/target/release/bundle/` (`bash scripts/app-linux.sh deb,appimage` para elegir otros). Los paquetes no se actualizan solos.

En Linux:
- las claves de API van en el llavero del sistema por Secret Service (GNOME Keyring o KWallet): sin uno abierto, no se pueden guardar;
- se leen las respuestas en voz alta si hay `espeak-ng` (o `espeak`, o `spd-say`);
- el dictado usa Vosk, porque Linux no trae un reconocedor de voz: se instala en Ajustes → General → Voz (descarga unos 47 MB, la biblioteca y el modelo pequeño de español, comprobados por su SHA-256, en `~/.config/Aquiles/dictado`) y funciona sin conexión. Graba con `parecord` (PulseAudio o PipeWire) o `arecord` (ALSA). Cada frase la reconoce un proceso aparte del núcleo (`aquiles-nucleo --dictado-linux`), como el programa de dictado de Mac;
- el control del navegador usa Microsoft Edge, Chrome o Chromium, el primero que encuentre en el PATH;
- la bandeja del sistema necesita AppIndicator (en GNOME, la extensión «AppIndicator and KStatusNotifierItem Support»);
- no hay instalación automática de llama.cpp ni de Docker (si ya están en el PATH, se usan).

Los datos van en `~/.config/Aquiles` (o en `$XDG_CONFIG_HOME/Aquiles`). Como en Mac, el núcleo recibe el PATH de tu shell, así que encuentra `claude`, `codex` o `agy` aunque estén en `~/.local/bin` o los haya puesto nvm.

Para hablar con un modelo hace falta al menos una de estas cosas:
- `agy`, `claude` o Codex instalado y con la sesión iniciada;
- una clave de API (en Ajustes → Modelos);
- Ollama o LM Studio en marcha.

## Desarrollo

Requisitos: los mismos que la instalación, es decir, Bun ≥ 1.4.4, Rust MSVC (lo selecciona `apps/escritorio/rust-toolchain.toml`) y Visual Studio Build Tools con C++. En Mac y Linux, Rust stable y lo que comprueba `instalar.sh`; la app se abre con `bun run escritorio:mac` o `bun run escritorio:linux`.

```bash
bun install
bun run escritorio                       # app en modo desarrollo (compila el núcleo y abre Tauri con Vite)
bun run comprobar                        # tipos, Biome, tests y validación del banco (lo mismo que el CI)
bun test                                 # tests del núcleo y del estado de la interfaz
bun run e2e                              # de extremo a extremo: núcleo simulado + interfaz + Chromium (Playwright)
bun run cli                              # chat por terminal; --proveedor, --modelo, --continuar, --reanudar <id>
bun run compilar:nucleo                  # núcleo → un único ejecutable para este sistema y arquitectura (el sidecar de la app)
bun banco/ejecutar.ts --proveedor agy    # mide el motor con el banco de tareas (usa un modelo real)
```

Para probar la interfaz en un navegador, sin Tauri:

```bash
bun packages/nucleo/src/main.ts --puerto 47420 --token dev
cd apps/escritorio && bun run dev
# http://localhost:1420/?ws=ws://127.0.0.1:47420&token=dev
```

## Estructura

```
apps/escritorio/      app de escritorio: src-tauri/ (Rust) y src/ (React)
packages/nucleo/      el agente: bucle, proveedores, herramientas, permisos, sesiones, memoria, skills,
                      aprendizaje, tareas programadas, canales, servidor JSON-RPC, CLI
packages/protocolo/   esquemas y tipos compartidos entre la app y el núcleo
packages/ui/          componentes y estilos de la interfaz
skills/               skills que vienen con Aquiles
banco/                20 tareas con comprobación automática para medir el motor
instalar.ps1          instalador y actualizador de Windows (compila desde main)
instalar.sh           lo mismo en Mac y Linux
```

## Cómo funciona

1. La app genera un token y lanza el núcleo (`aquiles-nucleo --puerto 0`).
2. El núcleo escucha solo en 127.0.0.1 y avisa de su puerto.
3. La interfaz se conecta por WebSocket y los dos hablan JSON-RPC 2.0 (`packages/protocolo`). El núcleo rechaza los tokens incorrectos y los orígenes que no son de la app.
4. Si el núcleo se cae, la app lo relanza; si se cierra la app, el núcleo termina con ella.

Los datos están en `%APPDATA%\Aquiles\perfiles\<perfil>\` en Windows y en `~/.config/Aquiles/perfiles/<perfil>/` en Mac y Linux (o en `AQUILES_HOME`): sesiones en JSONL, memoria, skills, índice de búsqueda, tareas programadas y ajustes. Las claves de API y los tokens van en el almacén de credenciales de Windows, en el Llavero de macOS o, en Linux, en el llavero de Secret Service.

## Licencia

[MIT](LICENSE). Puedes usar, copiar, modificar y distribuir el código, también en proyectos comerciales, siempre que mantengas el aviso de copyright y el texto de la licencia (atribución).
