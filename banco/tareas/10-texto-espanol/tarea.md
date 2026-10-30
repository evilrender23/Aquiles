El blog tiene problemas con el español:

- Los slugs de las URL se comen las letras con tilde y la ñ: «Año Nuevo en Cádiz» sale `a-o-nuevo-en-c-diz` y tendría que ser `ano-nuevo-en-cadiz`. Nada de tildes ni diéresis en el slug (la ñ pasa a n), todo en minúsculas, separado por guiones simples y sin guiones al principio ni al final.
- El índice alfabético manda al final las palabras que empiezan por tilde o por mayúscula. Tiene que ordenar como un diccionario español: la ñ va después de la n y las tildes y las mayúsculas no cuentan.
- El contador de palabras parte `señor` en dos y no reconoce `qué` ni `pingüino`. Las palabras pueden llevar tildes, ñ y ü, y no se distinguen mayúsculas de minúsculas.

Está todo en `src/texto.ts`.
