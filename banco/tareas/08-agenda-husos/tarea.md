Una usuaria de Madrid se queja de que la agenda le pone las citas de madrugada en el día anterior y con la hora cambiada. Las fechas y horas tienen que salir en la zona horaria que se pasa como parámetro (`Europe/Madrid`, `America/Mexico_City`, `Asia/Kolkata`...), con los cambios de horario de verano incluidos, y no en UTC ni en la zona del servidor.

Ojo: no todas las fechas vienen en UTC; algunas traen desfase (`2026-07-01T09:00:00+02:00`). Dentro de cada día, las citas tienen que ir en orden cronológico real.
