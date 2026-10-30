Cambios de configuración para el próximo despliegue:

- El servidor pasa a escuchar en el puerto 8080.
- Añade el francés (`fr`) a los idiomas admitidos.
- En producción hay que desactivar la depuración y poner el nivel de registro en `warn`.
- Activa la función `carritoNuevo`.
- Quita del todo la API antigua (`legacyApi`): ya no la usa nadie y no tiene que quedar ni rastro.
- Sube en uno la `version` de la configuración.

Lo demás tiene que quedar igual y la aplicación tiene que seguir arrancando con la configuración nueva.
