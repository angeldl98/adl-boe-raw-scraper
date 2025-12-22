/**
 * BOE cron scraper (headless, producción).
 * Usa el mismo flujo que el manual: listado HTTP + detalles Playwright.
 * Sin DRY_RUN. Máx 5 detalles, 5–10s entre visitas, guardarraíles activos.
 */
import "dotenv/config";
import { runScrape } from "../../src/scraper";

async function main() {
  await runScrape({ dryRun: false, headless: true });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[fatal] Cron scrape failed", err);
    process.exit(1);
  });
}

