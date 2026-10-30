7443

`src/config.ts` mezcla `config/base.json` (9000), encima `config/staging.json` (8443) y encima `.env.staging`, donde `PAGOS_PUERTO=7443` pisa al anterior. La tabla del README y `docs/despliegue.md` están desactualizados. (Una variable `PAGOS_PUERTO` en el entorno del proceso tendría aún más prioridad.)
