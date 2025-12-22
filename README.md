# ADL BOE RAW Scraper

## Manual scraper (PHASE S1.11)
Headful, IP-safe, manual-only tool to capturar listado + detalles BOE.

Run manually (from repo root):

```bash
npm install
npx ts-node scripts/boe/manual_scrape.ts               # listado HTTP + detalles Playwright (max 5)
DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # solo listado HTTP, logs, sin Playwright
```

Requisitos y reglas:
- Listado vía HTTP: submit real del formulario en `subastas_ava.php` y parseo de `li.resultado-busqueda a.resultado-busqueda-link-defecto`.
- Chromium visible (headless=false) **solo para detalles**, una pestaña, secuencial.
- Máx 5 páginas de detalle por run. Espera aleatoria 5–10s entre visitas de detalle.
- Stops on captcha/access denied/empty HTML/unexpected redirect/landing detected.
- Persiste listado (`fuente=BOE_LISTING`) y detalle (`fuente=BOE_DETAIL`) en `boe_subastas_raw` solo si pasan los marcadores de detalle.

Marcadores/guardarraíles:
- Detalle válido solo si contiene “Identificador”, “Tipo de subasta” y uno de (“Importe del depósito”, “Valor subasta”).
- Considerado landing si título “Portal de Subastas Electrónicas” y faltan marcadores; no se guarda y se detiene.

Config:
- Uses standard PG envs or DATABASE_URL as per `src/db.ts`.

Next (automation) is not enabled yet; see `systemd/` templates for future use.
