/**
 * BOE cron scraper (headless, producción).
 * Usa el mismo flujo que el manual: listado + detalles via Playwright.
 * Sin DRY_RUN. Máx 5 detalles, 5–10s entre visitas, guardarraíles activos.
 */
import "dotenv/config";
import { runScrape } from "../../src/scraper";
import { closeClient } from "../../src/db";

async function main() {
  try {
    const maxPagesEnv = Number(process.env.BOE_MAX_ITEMS || process.env.BOE_MAX_PAGES || "20");
    const maxPages = Number.isFinite(maxPagesEnv) && maxPagesEnv > 0 ? Math.min(Math.max(Math.floor(maxPagesEnv), 20), 100) : 20;
    await runScrape({ dryRun: false, headless: true, maxPages });
    await closeClient();
    process.exit(0);
  } catch (err) {
    await closeClient().catch(() => {});
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[fatal] Cron scrape failed", err);
    process.exit(1);
  });
}

