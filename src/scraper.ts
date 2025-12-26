import { chromium, Browser, Page, Locator } from "playwright";
import { ListingLink } from "./listing_http";
import { checksumSha256 } from "./checksum";
import { persistRaw } from "./persist";
import { getClient } from "./db";
import fs from "fs";
import path from "path";

const BASE_URL = process.env.BOE_BASE_URL || "https://subastas.boe.es";
const LISTING_URL = `${BASE_URL}/subastas_ava.php`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type ScrapeOptions = {
  dryRun: boolean;
  headless: boolean;
  maxPages?: number;
};

const DEFAULT_MAX_PAGES = Number.isFinite(Number(process.env.BOE_MAX_ITEMS))
  ? Math.min(Math.max(Number(process.env.BOE_MAX_ITEMS), 1), 5)
  : 5;
const MAX_DETAILS_DEFAULT = Number.isFinite(Number(process.env.BOE_MAX_DETAILS))
  ? Math.min(Math.max(Number(process.env.BOE_MAX_DETAILS), 1), 30)
  : 20;
const DETAIL_DELAY_MS = 4000; // fijo, sin aleatoriedad
const MAX_RUNTIME_MS = 8 * 60 * 1000; // 8 minutos de guardarraíl
const MAX_REQUESTS = 1 + MAX_DETAILS_DEFAULT; // listado + detalles

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
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
  return (
    lower.includes("búsqueda avanzada") ||
    lower.includes("busqueda avanzada") ||
    lower.includes("no se han encontrado documentos")
  );
}

function hasDetailMarkers(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("detalle de la subasta") ||
    lower.includes("ficha de la subasta") ||
    lower.includes("información de la subasta") ||
    lower.includes("datos de la subasta") ||
    lower.includes("identificador de la subasta") ||
    lower.includes("identificador")
  );
}

async function clickIfVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const button = locator.nth(i);
    if (await button.isVisible()) {
      await button.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function acceptCookies(page: Page): Promise<boolean> {
  const attempts: Locator[] = [
    page.getByRole("button", { name: /Aceptar y continuar/i }),
    page.getByRole("button", { name: /Aceptar/i }),
    page.locator("button#onetrust-accept-btn-handler"),
    page.locator("button.cookies-accept"),
    page.locator("button:has-text(\"Aceptar\")")
  ];

  for (const locator of attempts) {
    const clicked = await clickIfVisible(locator);
    if (clicked) {
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function setEstadoActivo(page: Page): Promise<void> {
  const estadoRadio = page.locator("input[name='dato[2]'][value='EJ']");
  if (await estadoRadio.count()) {
    await estadoRadio.first().check({ force: true }).catch(() => {});
  }
}

async function clearProvince(page: Page): Promise<void> {
  const provincia = page.locator("select[name='dato[8]']");
  if (await provincia.count()) {
    await provincia.selectOption({ value: "" }).catch(() => {});
  }
}

async function setDateRange(page: Page, start: Date, end: Date): Promise<void> {
  const startStr = formatDateInput(start);
  const endStr = formatDateInput(end);
  const selectors = ["input[name='dato[17][0]']", "input[name='dato[17][1]']"];

  for (const sel of selectors) {
    const input = page.locator(sel);
    if (await input.count()) {
      await input.fill("");
      // Solo imponemos fecha_fin desde hoy; dejamos hasta sin fijar para excluir históricas y no limitar futuras.
      await input.fill(sel.endsWith("[1]") ? "" : startStr);
    }
  }

  // Limpia fechas de inicio si hubieran valores previos
  for (const sel of ["input[name='dato[18][0]']", "input[name='dato[18][1]']"]) {
    const input = page.locator(sel);
    if (await input.count()) {
      await input.fill("");
    }
  }
}

async function extractDetailLinksFromPage(page: Page): Promise<ListingLink[]> {
  const anchors = await page.$$eval("a[href*='detalleSubasta.php']", (els) =>
    els
      .map((el) => {
        const href = (el as HTMLAnchorElement).getAttribute("href") || "";
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return { href, text };
      })
      .filter((l) => l.href.includes("idBus"))
  );

  const seen = new Set<string>();
  const links: ListingLink[] = [];
  for (const a of anchors) {
    try {
      const absolute = new URL(a.href, LISTING_URL).toString();
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      links.push({ href: a.href, absolute, text: a.text });
    } catch {
      continue;
    }
  }
  return links;
}

async function extractIdBusqueda(page: Page): Promise<string | null> {
  const url = page.url();
  const fromUrl = new URL(url).searchParams.get("id_busqueda");
  if (fromUrl) return fromUrl;

  const html = await page.content();
  const regex = /id_busqueda=([\w%]+)/i;
  const match = html.match(regex);
  if (match && match[1]) return decodeURIComponent(match[1]);

  const firstLink = await page.$("a[href*='detalleSubasta']");
  if (firstLink) {
    const href = (await firstLink.getAttribute("href")) || "";
    try {
      const idBus = new URL(href, LISTING_URL).searchParams.get("idBus");
      if (idBus) return idBus;
    } catch {
      /* ignore */
    }
  }

  return null;
}

async function ensureResults(page: Page): Promise<ListingLink[]> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  const hrefs = await page.$$eval("a[href*='detalleSubasta']", (as) =>
    as
      .map((a) => (a as HTMLAnchorElement).getAttribute("href"))
      .filter((h): h is string => Boolean(h))
  );
  if (!hrefs.length) {
    throw new Error("ZERO_LINKS_AFTER_SEARCH");
  }

  const seen = new Set<string>();
  const links: ListingLink[] = [];
  for (const href of hrefs) {
    try {
      const absolute = new URL(href, LISTING_URL).toString();
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      links.push({ href, absolute, text: "" });
    } catch {
      continue;
    }
  }
  return links;
}

type SubmitResult = { html: string; url: string; links: ListingLink[]; cookies: number; idBusqueda: string };

async function submitSearch(page: Page): Promise<SubmitResult> {
  const end = addDays(new Date(), 30);
  const start = new Date(); // activo: fecha_fin desde hoy

  await page.goto(LISTING_URL, { waitUntil: "domcontentloaded" });
  await acceptCookies(page).catch(() => {});
  await clearProvince(page);
  await setEstadoActivo(page);
  await setDateRange(page, start, end);

  const searchClick =
    (await clickIfVisible(page.getByRole("button", { name: /Buscar/i }))) ||
    (await clickIfVisible(page.locator("input[type='submit']")));

  if (!searchClick) {
    throw new Error("Search button not found/clicked");
  }

  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});

  const links = await ensureResults(page);

  const html = await page.content();
  const block = looksBlocked(html, page.url());
  if (block) {
    throw new Error(`LISTING_BLOCKED:${block}`);
  }
  const url = page.url();
  const cookies = (await page.context().cookies()).length;
  const idBusqueda = await extractIdBusqueda(page);
  if (!idBusqueda) {
    throw new Error("MISSING_ID_BUSQUEDA: do not retry");
  }

  console.log(`[info] id_busqueda=${idBusqueda} listing_links=${links.length} cookies=${cookies} url=${url}`);
  return { html, url, links, cookies, idBusqueda };
}

async function fetchListingWithPlaywright(
  page: Page
): Promise<{ html: string; url: string; links: ListingLink[]; idBusqueda?: string }> {
  console.log(`[info] Abriendo listado con Playwright: ${LISTING_URL}`);
  const listing = await submitSearch(page);
  console.log(`[info] cookies tras listado: ${listing.cookies}`);
  return listing;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function deriveBoeUid(url: string, html: string): string | null {
  const candidates = [url, html];
  for (const src of candidates) {
    const m = src.match(/(SUB-[A-Z0-9-]+)/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractPdfLinks(html: string, pageUrl: string): string[] {
  const regex = /href=["']([^"']+\.pdf[^"']*)["']/gi;
  const results = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;
    const absolute = new URL(href, pageUrl).toString();
    if (absolute.includes("Condiciones_procedimientos_enajenacion")) continue; // descartar PDF genérico
    results.add(absolute);
  }
  return Array.from(results);
}

async function persistPdf(rawId: number, boeUid: string | null, pdfUrl: string, buffer: Buffer, checksum: string): Promise<void> {
  const destDir = path.join("/opt/adl-suite/data/boe/pdfs", `raw-${rawId}`);
  ensureDir(destDir);
  const filePath = path.join(destDir, `${checksum}.pdf`);
  fs.writeFileSync(filePath, buffer);
  const client = await getClient();
  await client.query(
    `
      INSERT INTO boe_subastas_pdfs (raw_id, boe_uid, pdf_type, file_path, checksum, fetched_at)
      VALUES ($1,$2,$3,$4,$5, now())
      ON CONFLICT (raw_id, checksum) DO NOTHING
    `,
    [rawId, boeUid, "pdf", filePath, checksum]
  );
}

async function downloadFirstPdf(html: string, pageUrl: string, rawId: number): Promise<void> {
  const links = extractPdfLinks(html, pageUrl);
  if (!links.length) return;
  const pdfUrl = links[0];
  const res = await fetch(pdfUrl, { method: "GET" });
  if (!res.ok) {
    throw new Error(`PDF_DOWNLOAD_FAILED status=${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const checksum = checksumSha256(buffer.toString("binary"));
  const boeUid = deriveBoeUid(pageUrl, html);
  await persistPdf(rawId, boeUid, pdfUrl, buffer, checksum);
  console.log(`[info] pdf_saved url=${pdfUrl} raw_id=${rawId} bytes=${buffer.length}`);
}

export async function runScrape(options: ScrapeOptions): Promise<void> {
  const maxPages = Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, MAX_DETAILS_DEFAULT);
  const maxDetails = Math.min(MAX_DETAILS_DEFAULT, maxPages);
  const browser: Browser = await chromium.launch({ headless: options.headless, args: ["--no-sandbox"] });
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const startedAt = Date.now();
  let requestCount = 0;

  try {
    console.log(`[info] Inicio: listado Playwright + detalles Playwright (max ${maxPages})`);
    const listing = await fetchListingWithPlaywright(page);
    requestCount += 1;
    console.log(`[info] Listado obtenido desde ${listing.url}, html=${listing.html.length} chars`);
    console.log(`[info] Enlaces de detalle detectados: ${listing.links.length}`);

    if (!options.dryRun) {
      const listingChecksum = checksumSha256(listing.html);
      await persistRaw({ url: listing.url, payload: listing.html, checksum: listingChecksum, source: "BOE_LISTING" });
    }

    if (listing.links.length === 0) {
      throw new Error("ZERO_LINKS_AFTER_SEARCH: do not retry, do not advance dates");
    }

    const selected: ListingLink[] = listing.links.slice(0, maxDetails);

    for (let i = 0; i < selected.length; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME_MS) {
        throw new Error("MAX_RUNTIME_EXCEEDED");
      }
      if (requestCount >= MAX_REQUESTS) {
        console.warn("[warn] MAX_REQUESTS reached, stopping further detail fetches");
        break;
      }
      const link = selected[i];
      console.log(`[info] Visitando detalle ${i + 1}/${selected.length}: ${link.absolute}`);
      await safeWait(DETAIL_DELAY_MS);

      await page.goto(link.absolute, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      const html = await page.content();
      const block = looksBlocked(html, page.url());
      if (block) {
        throw new Error(`DETAIL_BLOCKED:${block}`);
      }
      if (looksLikeLanding(html)) {
        throw new Error(`DETAIL_VALIDATION_FAILED: landing detected ${link.absolute}`);
      }
      if (!hasDetailMarkers(html)) {
        throw new Error(`DETAIL_VALIDATION_FAILED: missing detail markers ${link.absolute}`);
      }

      if (!options.dryRun) {
        const checksum = checksumSha256(html);
        const rawId = await persistRaw({ url: page.url(), payload: html, checksum, source: "BOE_DETAIL" });
        await downloadFirstPdf(html, page.url(), rawId).catch((err) => {
          console.warn(`[warn] pdf_skip raw_id=${rawId} err=${err?.message || err}`);
        });
        console.log(`[info] detail_ok url=${page.url()} bytes=${html.length}`);
      }
      requestCount += 1;
    }

    console.log("[info] SUCCESS: inserted listing+detail");
  } finally {
    await browser.close();
  }
}

