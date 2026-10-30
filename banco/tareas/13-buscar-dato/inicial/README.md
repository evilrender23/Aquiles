# Plataforma

Servicios internos de la tienda.

## Servicios

| Servicio  | Puerto (producción) | Puerto (staging) |
|-----------|---------------------|------------------|
| catálogo  | 9100                | 8100             |
| pagos     | 9000                | 8443             |
| avisos    | 9200                | 8200             |

Arranque: `ENTORNO=staging bun src/main.ts`. Más detalles en `docs/despliegue.md`.
