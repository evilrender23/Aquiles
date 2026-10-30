El importador de clientes se rompe con el CSV que exporta el CRM: hay nombres con comas entre comillas, comillas dobles escapadas (`""`), notas de varias líneas y finales de línea de Windows. Tienes un ejemplo real en `datos/clientes.csv`.

Haz que `parsearCsv` entienda CSV estándar (RFC 4180) sin perder lo que ya hace: el separador sigue siendo configurable y las líneas vacías se siguen ignorando. `leerClientes` tiene que leer bien ese fichero de ejemplo.
