# ADL BOE RAW Scraper

## Manual scraper (PHASE S1.5)
Headful, IP-safe, manual-only tool to capture BOE detail pages.

Run manually (from repo root):

```bash
npm install
npx ts-node scripts/boe/manual_scrape.ts               # fetch + persist (max 5 details)
DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # discovery only, no visits/persist
```

Requirements & rules:
- Chromium visible (headless=false), single browser, single tab, sequential.
- Max 5 detail pages per run. Random delay 5–10s between actions.
- Opens https://subastas.boe.es, clicks “Buscar”, extracts up to 5 `ver_subasta` links, visits by click.
- Stops on captcha/access denied/empty HTML/unexpected redirect/landing detected.
- Persists to `boe_subastas_raw` (url, payload_raw, checksum, fetched_at) unless landing detected.

Landing vs detail guard:
- Considered landing if title “Portal de Subastas Electrónicas” AND missing detail markers (“Expediente”, “Importe base”, “Tipo de subasta”). Landing pages are NOT saved and the run stops.

Config:
- Uses standard PG envs or DATABASE_URL as per `src/db.ts`.

Next (automation) is not enabled yet; see `systemd/` templates for future use.
