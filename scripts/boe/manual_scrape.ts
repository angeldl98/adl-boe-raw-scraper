/**
 * BOE manual scraper v2 (PHASE S1.5)
 * ----------------------------------
 * DO NOT RUN AUTOMATICALLY. Manual, supervised runs only.
 * IP SAFETY FIRST: headful, single tab, sequential, max 5 detail pages, 5–10s random delays.
 *
 * How to run (manual, from repo root):
 *   npm install
 *   npx ts-node scripts/boe/manual_scrape.ts           # run (fetch + persist)
 *   DRY_RUN=true npx ts-node scripts/boe/manual_scrape.ts   # discover links only, no visits/persist
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
 *   - Extracts up to 5 detail links (href contains "ver_subasta").
 *   - Visits each by clicking the link (no direct navigation), waits for load, saves HTML to boe_subastas_raw (unless landing detected).
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

async function extractDetailHrefs(page: Page): Promise<string[]> {
  const hrefs = await page.$$eval("a[href*='ver_subasta']", (anchors) =>
    anchors
      .map((a) => (a as HTMLAnchorElement).getAttribute("href") || "")
      .filter((h) => h.includes("ver_subasta"))
  );
  const unique = Array.from(new Set(hrefs)).slice(0, MAX_PAGES);
  return unique.map((h) => (h.startsWith("http") ? h : `${window.location.origin}${h}`));
}

async function scrollListing(page: Page) {
  // Light, human-like scroll to load visible anchors
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

  const detailHrefs = await extractDetailHrefs(page);
  console.log(`[info] detail URLs found: ${detailHrefs.length}`);

  if (!DRY_RUN) {
    console.error("[fatal] Diagnostics must run in DRY_RUN mode. Set DRY_RUN=true.");
    return;
  }

  // Diagnostic: inspect listing DOM without visiting details
  const diag = await page.evaluate(() => {
    const bodyHtml = document.body?.innerHTML || "";
    const snippet = bodyHtml.replace(/\\s+/g, " ").slice(0, 2000);
    const allLinks = Array.from(document.querySelectorAll("a"));
    const linksWithHref = allLinks.filter((a) => a.getAttribute("href"));
    const linksContainingSubasta = linksWithHref.filter((a) =>
      (a.textContent || "").toLowerCase().includes("subasta")
    );
    const elementsWithOnclick = Array.from(document.querySelectorAll("[onclick]"));
    const keywordElems = Array.from(document.querySelectorAll("*")).filter((el) => {
      const txt = (el.textContent || "").toLowerCase();
      return (
        txt.includes("subasta") ||
        txt.includes("detalle") ||
        txt.includes("ver") ||
        txt.includes("expediente")
      );
    });

    const candidateSelectors: string[] = [];
    const anchorsVer = linksWithHref
      .filter((a) => {
        const href = a.getAttribute("href") || "";
        return href.includes("ver_subasta");
      })
      .slice(0, 5);
    anchorsVer.forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (href) candidateSelectors.push(`a[href='${href}']`);
    });
    const onclickCandidates = elementsWithOnclick.slice(0, 5).map((_, idx) => `[onclick]:nth-of-type(${idx + 1})`);
    candidateSelectors.push(...onclickCandidates);

    return {
      snippet,
      total_links: allLinks.length,
      links_with_href: linksWithHref.length,
      links_containing_subasta: linksContainingSubasta.length,
      elements_with_onclick: elementsWithOnclick.length,
      keyword_elements: keywordElems.length,
      candidate_selectors: Array.from(new Set(candidateSelectors)).slice(0, 5)
    };
  });

  console.log("[diagnostic]");
  console.log(`snippet: ${diag.snippet}`);
  console.log(`total_links: ${diag.total_links}`);
  console.log(`links_with_href: ${diag.links_with_href}`);
  console.log(`links_containing_subasta: ${diag.links_containing_subasta}`);
  console.log(`elements_with_onclick: ${diag.elements_with_onclick}`);
  console.log(`keyword_elements: ${diag.keyword_elements}`);
  console.log("possible_detail_selectors:");
  diag.candidate_selectors.forEach((s: string) => console.log(`  - ${s}`));
  console.log("[dry-run] Exiting after diagnostics (no visits, no persist).");
  return;

  const visits = Math.min(detailHrefs.length, MAX_PAGES);
  for (let i = 0; i < visits; i++) {
    const href = detailHrefs[i];
    console.log(`[info] Visiting detail ${i + 1}/${visits}: ${href}`);
    await safeWait(randomDelayMs());

    // Click via anchor on current page; if not found, stop.
    const relative = href.replace(BASE_URL, "");
    const link = page.locator(`a[href='${relative}'], a[href='${href}']`).first();
    if (!(await link.count())) {
      console.warn(`[warn] Link not present on listing page, stopping at ${href}`);
      break;
    }
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), link.click()]);

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
