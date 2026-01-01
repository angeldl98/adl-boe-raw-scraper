/**
 * BOE manual scraper v2 (PHASE S1.11)
 * Arquitectura final:
 *   - LISTADO y DETALLE con Playwright (subastas_ava.php, cookies aceptadas)
 *   - Una pestaña, secuencial, 5–10s de espera aleatoria, máximo 5 detalles por ejecución
 *   - Guardarraíles: CAPTCHA/denegado/redirecciones/landing vacía, marcadores de detalle obligatorios
 *
 * Cómo ejecutar manualmente (no automatizar):
 *   npm install
 *   DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # solo listado HTTP + logs, sin Playwright
 *   npx ts-node scripts/boe/manual_scrape.ts                # listado HTTP + detalles con Playwright (solo si aprobado)
 *
 * Flujo:
 *   1) Playwright abre https://subastas.boe.es/subastas_ava.php, acepta cookies y pulsa Buscar (dato[2]=PU si vacío)
 *   2) Parsear li.resultado-busqueda a.resultado-busqueda-link-defecto -> enlaces detalle
 *   3) DRY_RUN: log de cantidad, href, snippet; STOP (sin detalles)
 *   4) Real: Playwright headful para detalles conocidos; persistir solo si hay marcadores
 *
 * Safety stop conditions:
 *   - CAPTCHA / access denied / empty HTML / redirect outside subastas.boe.es
 *   - Landing page detected (title “Portal de Subastas Electrónicas” w/o markers)
 *   - Detail must contain markers: “Identificador”, “Tipo de subasta”, and one of (“Importe del depósito”, “Valor subasta”) to persist
 */

import "dotenv/config";
import { runScrape } from "../../src/scraper";

const DRY_RUN = process.env.DRY_RUN === "true";
const HEADLESS = process.env.HEADLESS !== "false";

async function runManual(): Promise<void> {
  await runScrape({ dryRun: DRY_RUN, headless: HEADLESS });
}

// Entry point for manual invocation only. Do NOT automate.
if (require.main === module) {
  runManual()
    .catch((err) => {
      console.error("[fatal] Manual scrape failed", err);
    })
    .finally(() => {
      // browser is left open intentionally for manual supervision
    });
}
