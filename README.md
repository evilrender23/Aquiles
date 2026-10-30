# Aquiles

Agente personal con app de escritorio. Código propio: núcleo en TypeScript sobre Bun y app en Tauri 2 + React.

Estado: **fase 1** (el motor). El plan completo está en la wiki del proyecto (`../wiki/plan-aquiles.md`).

## Estructura

```
apps/escritorio/        app Tauri 2: src-tauri/ (Rust) + src/ (React)
packages/nucleo/        el agente: bucle, proveedores, herramientas, permisos, sesiones, servidor JSON-RPC, CLI
packages/protocolo/     esquemas y tipos compartidos entre la app y el núcleo
banco/                  20 tareas con comprobación automática para medir el motor
```

Proveedores: `agy` (CLI de Google Antigravity, por defecto), `anthropic` (`ANTHROPIC_API_KEY`), `ollama`, `lmstudio`, `openrouter`, `openai` (estos cuatro con `--modelo`) y `simulado`.
Los datos (sesiones, salidas largas) van a `%APPDATA%\Aquiles\perfiles\<perfil>\`, o a `AQUILES_HOME`.

## Requisitos (Windows)

- [Bun](https://bun.sh) ≥ 1.4.4.
- Rust con el toolchain `stable-x86_64-pc-windows-msvc`. `src-tauri/rust-toolchain.toml` lo selecciona solo y necesita Visual Studio Build Tools con C++.
- WebView2 (viene con Windows 11).
- Para hablar con un modelo: el CLI de Google Antigravity (`agy`) con la sesión iniciada. Es el único proveedor real por ahora.

## Comandos

```bash
bun install
bun test                                        # tests del núcleo
bun run cli                                     # chat por terminal (proveedor agy)
bun run cli -- --proveedor simulado             # sin modelo real
bun run cli -- --continuar                      # reanuda la última sesión (o --reanudar <id>)
bun run cli -- --modo-aprobacion libre-proyecto # sin preguntar dentro de la carpeta
bun banco/ejecutar.ts --validar                 # comprueba las tareas del banco (sin modelo)
bun banco/ejecutar.ts --proveedor agy           # mide el motor con un modelo real (tarda)
bun packages/nucleo/scripts/probar-agy.ts       # prueba de humo con un modelo real (gasta cuota)
bun run compilar:nucleo                         # núcleo → .exe único (sidecar de la app)
bun packages/nucleo/scripts/medir-arranque.ts   # arranque del .exe y FTS5
bun run escritorio                              # compila el núcleo y abre la app en modo desarrollo
```

Para probar la interfaz en un navegador sin Tauri, arranca el núcleo con un token y abre Vite con la URL del WebSocket:

```bash
bun packages/nucleo/src/main.ts --puerto 47420 --token dev
cd apps/escritorio && bun run dev
# http://localhost:1420/?ws=ws://127.0.0.1:47420&token=dev
```

## Cómo se conectan

1. La app genera un token y lanza `aquiles-nucleo --puerto 0` con `AQUILES_TOKEN`.
2. El núcleo escucha solo en 127.0.0.1 e imprime `AQUILES_READY port=N`.
3. La interfaz pide URL y token a Tauri (`conexion_nucleo`) y abre el WebSocket `/rpc?token=…`.
4. Se hablan con JSON-RPC 2.0 (`packages/protocolo`). El núcleo rechaza tokens malos y orígenes que no sean de la app.
5. Si la app muere, se cierra el stdin del núcleo y este termina.
