# ADL BOE RAW Scraper

## Pipeline BOE (estable)

Flujo: Listado y detalles con Playwright (formulario real en `subastas_ava.php`, cookies aceptadas en el banner) → RAW en `boe_subastas_raw` → Normalización (cheerio) → `boe_subastas_public` → API `/api/subastas/free|pro` → Web (no consume RAW).

Run manually (from repo root):

```bash
npm install
DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # listado Playwright, logs, sin detalles
npx ts-node scripts/boe/manual_scrape.ts                # listado + detalles Playwright headful (máx 5)
xvfb-run -a npx ts-node scripts/boe/cron_scrape.ts      # headless, para cron
npx ts-node scripts/boe/normalize.ts                    # normaliza RAW → boe_subastas_public
```

Requisitos y reglas:
- Listado vía Playwright: abre `subastas_ava.php`, acepta cookies, fuerza `dato[2]=PU` si viene vacío y pulsa “Buscar”; parseo de `li.resultado-busqueda a.resultado-busqueda-link-defecto`.
- Playwright para detalles: headful en manual, headless en cron. Una pestaña, secuencial.
- Máx 5 páginas de detalle por run. Espera aleatoria 5–10s entre visitas de detalle.
- Guardarraíles: captcha/access denied/empty HTML/unexpected redirect/landing detected. Detalles deben contener “Identificador”, “Tipo de subasta” y uno de (“Importe del depósito”, “Valor subasta”).
- Persistencia: listado (`fuente=BOE_LISTING`) y detalle (`fuente=BOE_DETAIL`) en `boe_subastas_raw`.
- Normalización: `scripts/boe/normalize.ts` lee `boe_subastas_raw` (detalles), parsea con cheerio y escribe en `boe_subastas_public` (tabla nueva, RAW no se toca).

Marcadores/guardarraíles:
- Detalle válido solo si contiene “Identificador”, “Tipo de subasta” y uno de (“Importe del depósito”, “Valor subasta”).
- Considerado landing si título “Portal de Subastas Electrónicas” y faltan marcadores; no se guarda y se detiene.

API (contrato, no UI):
- `/api/subastas/free`: campos limitados, sin documentos ni info sensible, basados en `boe_subastas_public`.
- `/api/subastas/pro`: datos completos normalizados, listos para análisis, basados en `boe_subastas_public`.

Config:
- Uses standard PG envs or DATABASE_URL as per `src/db.ts`.

Next (automation) is not enabled yet; see `systemd/` templates for future use.
