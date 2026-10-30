---
name: escribir-skills
description: Cómo escribir o ampliar una skill de Aquiles (SKILL.md) para una clase de tarea que se repite. Úsala antes de crear o parchear una skill con gestionar_skill.
---

# Escribir skills

Una skill guarda un procedimiento que ya ha funcionado, para no tener que redescubrirlo la próxima vez.

## Cuándo crear una
- Has terminado una tarea de varios pasos que no eran obvios y es probable que vuelva: otra versión, otro proyecto, otro día.
- El usuario te ha corregido el método, no solo el resultado.
- No crees una para un dato suelto (eso va a la memoria), para una tarea que no se repetirá ni para algo que otra skill ya cubre. En ese caso, amplía la que hay.

## Nombre y descripción
- El nombre va en kebab-case y nombra la clase de tarea: `publicar-version-npm`, no `publicar-la-1-4-2`.
- La descripción es lo que decide si la skill se carga. Di qué hace y cuándo usarla, con las palabras que usaría el usuario al pedirlo.

## Cuerpo
1. Una o dos frases sobre para qué sirve.
2. Los pasos numerados, con los comandos exactos y desde qué carpeta se ejecutan.
3. Una sección «Trampas»: lo que falló y cómo se evita.
4. Cómo se comprueba que ha salido bien.

Mantenla corta. Si pasa de unas 150 líneas, mueve el detalle a `references/` y enlázalo. No guardes secretos, rutas personales innecesarias ni datos que solo valían para una sesión.

## Mantenerla
- Si al seguirla algo ha cambiado, parchéala en la misma sesión con `gestionar_skill` (acción `parchear`).
- Antes de crear una nueva, revisa el índice de skills del system prompt y abre con `ver_skill` las que se parezcan.
