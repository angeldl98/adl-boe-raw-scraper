/**
 * BOE manual scraper v2 (PHASE S1.10) - listing flow fix
 * DO NOT RUN AUTOMATICALLY. Manual, supervised runs only.
 * IP SAFETY FIRST: headful, single tab, sequential, max 5 detail pages, 5–10s random delays.
 *
 * How to run (manual, from repo root):
 *   npm install
 *   DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # discovery only (no clicks into details)
 *   npx ts-node scripts/boe/manual_scrape.ts                # detail clicks/persist ONLY if explicitly approved
 *
 * Flow (must mimic human):
 *   - Go to https://subastas.boe.es/subastas_ava.php
 *   - Wait for search form, click real “Buscar” submit button (no handcrafted URLs)
 *   - Wait for navigation + results container div.listadoResult
 *   - Collect li.resultado-busqueda a.resultado-busqueda-link-defecto (max 5)
 *   - DRY_RUN: log count, href, snippet; STOP (no detail clicks)
 *   - Real run: click each anchor, wait navigation, guard checks, persist if detail markers present
 *
 * Safety stop conditions:
 *   - CAPTCHA / access denied / empty HTML / redirect outside subastas.boe.es
 *   - Landing page detected (title “Portal de Subastas Electrónicas” w/o markers)
 *   - Detail must contain markers: “Identificador”, “Tipo de subasta”, and one of (“Importe del depósito”, “Valor subasta”) to persist
 */

import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import { persistRaw } from "../../src/persist";
import { checksumSha256 } from "../../src/checksum";

const MAX_PAGES = 5;
const BASE_URL = "https://subastas.boe.es";
const LISTING_URL = `${BASE_URL}/subastas_ava.php`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DRY_RUN = process.env.DRY_RUN === "true";
const RESULT_ITEM = "li.resultado-busqueda";
const RESULT_LINK = "li.resultado-busqueda a.resultado-busqueda-link-defecto";

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

  await page.goto(LISTING_URL, { waitUntil: "networkidle" });
  await safeWait(randomDelayMs());

  // Wait for the search form and real submit button
  const submitBtn = page.locator("input[type='submit'], button:has-text('Buscar')").first();
  try {
    await submitBtn.waitFor({ timeout: 15000 });
  } catch {
    console.error("[error] Search submit button not found");
    return;
  }

  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), submitBtn.click()]);

  // Wait for results container
  try {
    await page.waitForSelector("div.listadoResult", { timeout: 15000 });
  } catch {
    console.error("[error] Results container not found (div.listadoResult)");
    return;
  }

  await scrollListing(page);

  try {
    await page.waitForSelector(RESULT_ITEM, { timeout: 15000 });
  } catch {
    console.error(`[error] Result items not found: ${RESULT_ITEM}`);
    return;
  }

  const links = await page.$$(RESULT_LINK);
  const targets = links.slice(0, MAX_PAGES);
  console.log(`[info] result links found: ${links.length}, will process: ${targets.length}`);

  if (DRY_RUN) {
    for (let i = 0; i < targets.length; i++) {
      const href = await targets[i].getAttribute("href");
      const text = (await targets[i].innerText()).replace(/\s+/g, " ").slice(0, 200);
      console.log(`[dry-run] would click result ${i + 1}/${targets.length} href=${href}`);
      console.log(`[dry-run] text: ${text}`);
    }
    console.log("[dry-run] Exiting (no clicks, no visits, no persist).");
    return;
  }

  const visits = targets.length;
  for (let i = 0; i < visits; i++) {
    const href = await targets[i].getAttribute("href");
    console.log(`[info] Visiting result ${i + 1}/${visits} via anchor href=${href}`);
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

    if (!hasDetailMarkers(html)) {
      console.warn("[warn] Detail markers missing (Identificador/Tipo/Importe); not saving.");
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
