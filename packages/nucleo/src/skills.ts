/**
 * Skills en formato SKILL.md (frontmatter YAML con name y description) en <raíz>/<nombre>/SKILL.md, con ficheros
 * de apoyo opcionales en references/, templates/ y scripts/. Raíces, de más a menos precedencia: proyecto
 * (<cwd>/.aquiles/skills y <cwd>/.claude/skills), perfil (<perfil>/skills) e incluidas.
 * Registro por nombre en <perfil>/skills.json: origen, activa, usos, ultimoUso, creada y lo del curador.
 * Curador (solo las aprendidas del perfil): sin actividad 14 días → obsoleta; 30 → se mueve a <perfil>/skills-archivadas/.
 * Antes de cambiar una skill del perfil se copia entera en <perfil>/skills-copias/<nombre>/<id>/ (con meta.json).
 * Nada de esto borra skills ni copias.
 * Partes: skills/carga.ts (raíces, frontmatter y validación), skills/almacen.ts (AlmacenSkills: registro, curador
 * y copias) y skills/herramientas.ts (ver_skill y gestionar_skill).
 */
export { AlmacenSkills } from "./skills/almacen";
export { ErrorSkill } from "./skills/carga";
export { type DetalleCambioSkill, herramientasSkills } from "./skills/herramientas";
