# adl-boe-raw-scraper

Repositorio mínimo y auditable para la extracción **RAW** de datos del BOE (subastas). Alcance fijo e inmutable:

- Solo obtiene y persiste datos en crudo.
- No analiza ni interpreta la información (normalización/IA ocurren aguas abajo).
- Alimenta a sistemas posteriores (normalizer / analyst).
- La seguridad IP es prioritaria; cualquier lógica futura debe ser respetuosa con límites y bloqueo.

Arquitectura básica:
- `src/main.ts`: punto de entrada.
- `src/fetch.ts`: obtención futura de datos RAW.
- `src/persist.ts`: persistencia de los datos RAW.
- `src/checksum.ts`: utilidades de checksum.
- `src/db.ts`: conexión y utilidades de base de datos.

Build y ejecución:
1) `npm install`
2) `npm run build`
3) `npm start` (usa `dist/main.js`)

El Dockerfile es solo de runtime: asume que `dist/` fue generado previamente y no compila dentro del contenedor.

