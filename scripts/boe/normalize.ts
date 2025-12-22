/**
 * Normalizador BOE: lee boe_subastas_raw (fuente=BOE_DETAIL) y escribe boe_subastas_public.
 * No toca RAW. Usa cheerio para parsear los campos obligatorios.
 */
import "dotenv/config";
import { normalizeFromRaw } from "../../src/normalize";

async function main() {
  await normalizeFromRaw(200);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[fatal] Normalize failed", err);
    process.exit(1);
  });
}

