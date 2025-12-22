/**
 * BOE manual scraper v2 (PHASE S1.5/S1.7)
 * ---------------------------------------
 * DO NOT RUN AUTOMATICALLY. Manual, supervised runs only.
 * IP SAFETY FIRST: headful, single tab, sequential, max 5 detail pages, 5–10s random delays.
 *
 * How to run (manual, from repo root):
 *   npm install
 *   npx ts-node scripts/boe/manual_scrape.ts           # run (fetch + persist)
 *   DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # discovery/diagnostic only (no clicks, no persist)
 *
 * Preconditions:
 *   - Visible Chromium (headless=false).
 *   - One browser, one page.
 *   - Network stable; stop on captcha/denegado/empty body/landing detected.
 *   - Do NOT change limits; maxPages = 5.
 *
 * What it does:
 *   - Opens https://subastas.boe.es
 *   - Clicks “Buscar” (listing) like a user.
 *   - Waits for result items with onclick (selector: [onclick*="ver_subasta"]).
 *   - DRY_RUN: logs items that would be clicked; exits.
 *   - Real run: clicks each item (no direct navigation), waits load, saves HTML to boe_subastas_raw (unless landing detected).
 *   - Waits 5–10s between actions. Stops on any block signal.
 *
 * What it DOES NOT do:
 *   - No normalization, no analyst, no PDFs, no retries, no pagination loops.
 *
 * Safety stop conditions:
 *   - CAPTCHA text detected
 *   - Access denied text
 *   - Empty/too short HTML
 *   - Unexpected redirect away from subastas.boe.es
 *   - Landing page detected (title “Portal de Subastas Electrónicas” and missing detail markers)
 */

import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import { persistRaw } from "../../src/persist";
import { checksumSha256 } from "../../src/checksum";

const MAX_PAGES = 5;
const BASE_URL = "https://subastas.boe.es";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DRY_RUN = process.env.DRY_RUN === "true";
const RESULT_SELECTOR = '[onclick*="ver_subasta"]';

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

async function scrollListing(page: Page) {
  // Light, human-like scroll to load visible items
  await page.mouse.wheel(0, 800);
  await safeWait(800 + Math.random() * 400);
  await page.mouse.wheel(0, 800);
  await safeWait(500 + Math.random() * 400);
}

async function runManual(): Promise<void> {
  console.log("[info] Starting manual BOE scrape (headful, max 5 pages)");

  const browser: Browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await safeWait(randomDelayMs());

  // Click "Buscar" to reach listing (no direct nav)
  const buscar = page.locator("a:has-text('Buscar')").first();
  if (await buscar.count()) {
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), buscar.click()]);
  } else {
    console.warn("[warn] Buscar link not found; staying on home");
  }

  await scrollListing(page);

  try {
    await page.waitForSelector(RESULT_SELECTOR, { timeout: 15000 });
  } catch {
    console.error(`[error] Result selector not found: ${RESULT_SELECTOR}`);
    return;
  }

  const resultHandles = await page.$$(RESULT_SELECTOR);
  const targets = resultHandles.slice(0, MAX_PAGES);
  console.log(`[info] result items found: ${resultHandles.length}, will process: ${targets.length}`);

  if (DRY_RUN) {
    for (let i = 0; i < targets.length; i++) {
      console.log(`[dry-run] would click result ${i + 1}/${targets.length} using selector ${RESULT_SELECTOR}`);
    }
    console.log("[dry-run] Exiting (no clicks, no visits, no persist).");
    return;
  }

  const visits = targets.length;
  for (let i = 0; i < visits; i++) {
    console.log(`[info] Visiting result ${i + 1}/${visits} via onclick element`);
    await safeWait(randomDelayMs());

    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), targets[i].click()]);

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

    const checksum = checksumSha256(html);
    await persistRaw({ url: page.url(), payload: html, checksum });
    console.log(`[info] saved payload for ${page.url()}`);

    // Return to listing for next link
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), page.goBack()]);
  }

  console.log("[info] Done (manual run). Close the browser manually if needed.");
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
