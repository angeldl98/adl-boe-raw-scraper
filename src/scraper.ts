import { chromium, Browser } from "playwright";
import { fetchListingPage, ListingLink } from "./listing_http";
import { checksumSha256 } from "./checksum";
import { persistRaw } from "./persist";

const BASE_URL = "https://subastas.boe.es";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type ScrapeOptions = {
  dryRun: boolean;
  headless: boolean;
  maxPages?: number;
};

const DEFAULT_MAX_PAGES = 5;

function randomDelayMs() {
  const seconds = 5 + Math.random() * 5; // 5-10s
  return Math.floor(seconds * 1000);
}

async function safeWait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksBlocked(html: string, url: string): string | null {
  const lower = html.toLowerCase();
  if (!html || html.trim().length < 500) return "empty_or_too_short";
  if (lower.includes("captcha")) return "captcha_detected";
  if (lower.includes("acceso denegado") || lower.includes("access denied")) return "access_denied";
  if (!url.startsWith(BASE_URL)) return "unexpected_redirect";
  return null;
}

function looksLikeLanding(html: string): boolean {
  const lower = html.toLowerCase();
  const hasPortalTitle = lower.includes("portal de subastas electr");
  const hasDetailMarkers = lower.includes("expediente") || lower.includes("importe base") || lower.includes("tipo de subasta");
  return hasPortalTitle && !hasDetailMarkers;
}

function hasDetailMarkers(html: string): boolean {
  const lower = html.toLowerCase();
  const hasId = lower.includes("identificador");
  const hasTipo = lower.includes("tipo de subasta");
  const hasImporte = lower.includes("importe del dep") || lower.includes("valor subasta");
  return hasId && hasTipo && hasImporte;
}

export async function runScrape(options: ScrapeOptions): Promise<void> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  console.log(`[info] Inicio: listado HTTP + detalles Playwright (max ${maxPages})`);

  const listing = await fetchListingPage();
  console.log(`[info] Listado obtenido desde ${listing.url}, html=${listing.html.length} chars`);
  console.log(`[info] Enlaces de detalle detectados: ${listing.links.length}`);

  const selected: ListingLink[] = listing.links.slice(0, maxPages);

  if (!options.dryRun) {
    const listingChecksum = checksumSha256(listing.html);
    await persistRaw({ url: listing.url, payload: listing.html, checksum: listingChecksum, source: "BOE_LISTING" });
  }

  if (options.dryRun) {
    for (let i = 0; i < selected.length; i++) {
      const link = selected[i];
      const text = link.text.replace(/\s+/g, " ").slice(0, 200);
      console.log(`[dry-run] resultado ${i + 1}/${selected.length} href=${link.absolute}`);
      console.log(`[dry-run] text: ${text}`);
    }
    console.log("[dry-run] STOP (solo listado HTTP, sin Playwright de detalle).");
    return;
  }

  const browser: Browser = await chromium.launch({ headless: options.headless, args: ["--no-sandbox"] });
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  for (let i = 0; i < selected.length; i++) {
    const link = selected[i];
    console.log(`[info] Visitando detalle ${i + 1}/${selected.length}: ${link.absolute}`);
    await safeWait(randomDelayMs());

    await page.goto(link.absolute, { waitUntil: "networkidle" });

    const html = await page.content();
    const block = looksBlocked(html, page.url());
    if (block) {
      console.error(`[error] Block signal detected (${block}); stopping.`);
      break;
    }

    if (looksLikeLanding(html)) {
      console.warn("[warn] Landing page detected; not saving payload. Stopping to avoid bad data.");
      break;
    }

    if (!hasDetailMarkers(html)) {
      console.warn("[warn] Detail markers missing (Identificador/Tipo/Importe); not saving.");
      break;
    }

    const checksum = checksumSha256(html);
    await persistRaw({ url: page.url(), payload: html, checksum, source: "BOE_DETAIL" });
    console.log(`[info] saved payload for ${page.url()}`);
  }

  await browser.close();
  console.log("[info] Fin scraper (se cerró el navegador).");
}

