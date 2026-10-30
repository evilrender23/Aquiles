# Aquiles

Agente personal para Windows con app de escritorio. Trabaja con tus ficheros y tu terminal, recuerda lo que aprende y puede ejecutar tareas por su cuenta. Tiene dos partes:
- el **núcleo**, que es el agente, en TypeScript sobre Bun;
- la **app**, en Tauri 2 y React.

Es un proyecto personal: lo hago para mi propio uso y no hay soporte. El código es público bajo la licencia MIT (ver [Licencia](#licencia)).

## Qué hace

- **Conversación con herramientas:** leer, buscar, editar y crear ficheros; terminal persistente (local, en un contenedor Docker o por SSH); búsqueda y lectura de webs; control de Edge (desactivado por defecto); servidores MCP.
- **Permisos:** escribe sin preguntar dentro de la carpeta de trabajo y pregunta antes de ejecutar comandos. También se puede elegir «preguntar siempre» o «libre en el proyecto». Hay un guardián opcional: un modelo que aprueba lo claramente seguro.
- **Memoria y skills:** memoria corta del usuario, del agente y de cada proyecto, más una personalidad editable; skills en formato `SKILL.md`; búsqueda de texto en todas las conversaciones.
- **Aprendizaje:** una revisión en segundo plano propone qué recordar de cada conversación, y tú aceptas o descartas. Todo lo aprendido queda registrado con su sesión de origen. Las skills aprendidas que no se usan se archivan, sin borrarse.
- **Subagentes:** reparte trabajo independiente entre varias instancias de Aquiles que trabajan en paralelo. Desde un panel se pueden seguir, reconducir y parar.
- **Automatizaciones:**
  - tareas programadas («cada lunes 9:00», «en 30m» o cron) que entregan el resultado en el escritorio, Telegram, Discord, Slack o por correo;
  - conversación desde esos chats;
  - kanban en el que cada tarjeta se encarga a un agente;
  - objetivos con un juez que decide si el trabajo está acabado.
- **Modelos:** los CLI de Antigravity (`agy`) y de Claude Code (`claude`) con la cuenta en la que hayas iniciado sesión; Anthropic, OpenAI y OpenRouter con clave de API; Ollama y LM Studio en local.
- **Aplicación:**
  - bandeja del sistema y arranque con Windows;
  - atajo global con entrada rápida;
  - perfiles, copias de seguridad y restauración;
  - voz (dictado y lectura) con las voces locales de Windows;
  - estadísticas;
  - modo remoto (la app conectada a un núcleo en otra máquina);
  - integración con editores por ACP (`aquiles-nucleo --acp`).

## Instalación

En PowerShell:

```powershell
irm https://raw.githubusercontent.com/evilrender23/Aquiles/main/instalar.ps1 | iex
```

El script hace tres cosas:
1. Comprueba los requisitos: Git, Bun, Rust con el toolchain MSVC, Visual Studio Build Tools con C++ y WebView2. Si falta alguno, pregunta antes de instalarlo con winget.
2. Descarga la rama `main` en `%LOCALAPPDATA%\Aquiles\codigo`.
3. La compila, la instala en `%LOCALAPPDATA%\Aquiles\app` y crea un acceso directo en el menú Inicio.

La app se mantiene al día sola: cuando `main` tiene commits nuevos, los compila en segundo plano y los aplica al reiniciarla. También se puede comprobar a mano en Ajustes → Aplicación.

Para hablar con un modelo hace falta al menos una de estas cosas:
- `agy` o `claude` instalado y con la sesión iniciada;
- una clave de API (en Ajustes → Claves);
- Ollama o LM Studio en marcha.

## Desarrollo

Requisitos: los mismos que la instalación, es decir, Bun ≥ 1.4.4, Rust MSVC (lo selecciona `apps/escritorio/rust-toolchain.toml`) y Visual Studio Build Tools con C++.

```bash
bun install
bun run escritorio                       # app en modo desarrollo (compila el núcleo y abre Tauri con Vite)
bun run comprobar                        # tipos, Biome, tests y validación del banco (lo mismo que el CI)
bun test                                 # tests del núcleo
bun run cli                              # chat por terminal; --proveedor, --modelo, --continuar, --reanudar <id>
bun run compilar:nucleo                  # núcleo → un único .exe (el sidecar de la app)
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
instalar.ps1          instalador y actualizador (compila desde main)
```

## Cómo funciona

1. La app genera un token y lanza el núcleo (`aquiles-nucleo --puerto 0`).
2. El núcleo escucha solo en 127.0.0.1 y avisa de su puerto.
3. La interfaz se conecta por WebSocket y los dos hablan JSON-RPC 2.0 (`packages/protocolo`). El núcleo rechaza los tokens incorrectos y los orígenes que no son de la app.
4. Si el núcleo se cae, la app lo relanza; si se cierra la app, el núcleo termina con ella.

Los datos están en `%APPDATA%\Aquiles\perfiles\<perfil>\` (o en `AQUILES_HOME`): sesiones en JSONL, memoria, skills, índice de búsqueda, tareas programadas y ajustes. Las claves de API y los tokens van en el almacén de credenciales de Windows.

## Licencia

[MIT](LICENSE). Puedes usar, copiar, modificar y distribuir el código, también en proyectos comerciales, siempre que mantengas el aviso de copyright y el texto de la licencia (atribución).
