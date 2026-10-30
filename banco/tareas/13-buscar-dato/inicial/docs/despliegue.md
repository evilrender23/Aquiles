# Despliegue

Cada entorno tiene su fichero en `config/` (`produccion.json`, `staging.json`) que se mezcla encima de `config/base.json`.

En staging los servicios usan los puertos de `config/staging.json`. Si cambias un puerto, avisa a sistemas para que actualicen el cortafuegos.

Última revisión: marzo de 2025.
