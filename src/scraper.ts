import { chromium, Browser, Page, Locator } from "playwright";
import { ListingLink } from "./listing_http";
import { checksumSha256 } from "./checksum";
import { persistRaw } from "./persist";
import { getClient } from "./db";
import fs from "fs";
import path from "path";
import { URL } from "url";

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
  ? Math.min(Math.max(Number(process.env.BOE_MAX_ITEMS), 3), 5)
  : 5;
const MAX_PAGES_CAP = 5; // pauta fija: 3-5 páginas
const MAX_DETAILS_DEFAULT = Number.isFinite(Number(process.env.BOE_MAX_DETAILS))
  ? Math.min(Math.max(Number(process.env.BOE_MAX_DETAILS), 1), 25)
  : 20;
const MAX_DETAILS_CAP = 25;
const DETAIL_DELAY_MS = 4000; // fijo, sin aleatoriedad
const MAX_RUNTIME_MS = 8 * 60 * 1000; // 8 minutos de guardarraíl
const MAX_REQUESTS = 1 + 2 * MAX_DETAILS_CAP; // listado + detalle + lotes
const LOT_DELAY_MS = 1000; // breve pausa antes de cargar lotes
const PDF_DELAY_MS = 4000; // retraso fijo antes de descargar PDF
const PDF_MAX_BYTES = 15 * 1024 * 1024; // 15MB límite duro
const PDF_TIMEOUT_MS = 30_000; // 30s por PDF
const STORAGE_STATE_PATH = process.env.BOE_STORAGE_STATE || "/opt/adl-suite/data/boe_auth/storageState.json";
const STORAGE_STATE_DIR = path.dirname(STORAGE_STATE_PATH);
const BOE_LOGIN_URL = process.env.BOE_LOGIN_URL || "https://subastas.boe.es/login.php";
const BOE_PROXY = process.env.BOE_PROXY || "";

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
      // Ventana explícita: fecha_fin >= hoy y hasta end (p.ej. +30d)
      await input.fill(sel.endsWith("[1]") ? endStr : startStr);
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
    if (!absolute.startsWith(BASE_URL)) continue; // solo dominio BOE
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

async function downloadFirstPdf(
  boeUid: string | null,
  rawId: number | null,
  page: Page,
  links: string[]
): Promise<{ filePath: string; checksum: string } | null> {
  if (!boeUid) return null;
  if (!links.length) return null;
  const pdfUrl = links[0];
  await safeWait(PDF_DELAY_MS);

  const response = await page.goto(pdfUrl, { waitUntil: "networkidle", timeout: PDF_TIMEOUT_MS });
  if (!response) throw new Error("PDF_ABORTED:no_response");
  const status = response.status();
  if (status >= 400) throw new Error(`PDF_ABORTED:http_${status}`);
  const ct = (response.headers()["content-type"] || "").toLowerCase();
  if (!ct.includes("application/pdf")) {
    throw new Error(`PDF_ABORTED:not_pdf content_type=${ct}`);
  }
  const len = Number(response.headers()["content-length"] || "0");
  if (len > PDF_MAX_BYTES) throw new Error(`PDF_ABORTED:too_large content_length=${len}`);
  const buffer = Buffer.from(await response.body());
  if (buffer.byteLength > PDF_MAX_BYTES) throw new Error(`PDF_ABORTED:too_large body_length=${buffer.byteLength}`);
  const checksum = checksumSha256(buffer.toString("binary"));
  const destDir = path.join("/opt/adl-suite/data/boe_pdfs", boeUid);
  ensureDir(destDir);
  const filePath = path.join(destDir, `${checksum}.pdf`);
  fs.writeFileSync(filePath, buffer);
  if (rawId !== null) {
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
  console.log(`[info] PDF_SAVED boe_uid=${boeUid} url=${pdfUrl} bytes=${buffer.length} checksum=${checksum}`);
  return { filePath, checksum };
}

function parseEuroToNumber(val: string | null | undefined): number | null {
  if (!val) return null;
  const cleaned = val.replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractLotValues(html: string): number[] {
  const regex = /Valor\s+Subasta<\/th>\s*<td>\s*([^<]+)\s*</gi;
  const values: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const val = parseEuroToNumber(match[1]);
    if (val !== null) values.push(val);
  }
  return values;
}

function buildLotUrl(detailUrl: string, idBus?: string | null): string {
  const u = new URL(detailUrl);
  u.searchParams.set("ver", "3");
  if (idBus && !u.searchParams.get("idBus")) {
    u.searchParams.set("idBus", idBus);
  }
  return u.toString();
}

export async function runScrape(options: ScrapeOptions): Promise<void> {
  const maxPagesRequested = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxPages = Math.min(maxPagesRequested, MAX_PAGES_CAP);
  const maxDetails = Math.min(MAX_DETAILS_DEFAULT, MAX_DETAILS_CAP, maxPages * 5); // tope fijo de detalles
  ensureDir(STORAGE_STATE_DIR);
  const launchArgs = ["--no-sandbox"];
  if (BOE_PROXY) {
    launchArgs.push(`--proxy-server=${BOE_PROXY}`);
  }
  const browser: Browser = await chromium.launch({ headless: options.headless, args: launchArgs });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    storageState: fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined
  });
  const page = await context.newPage();
  const sessionLoaded = fs.existsSync(STORAGE_STATE_PATH);
  console.log(`[info] ${sessionLoaded ? "AUTH_SESSION_LOADED" : "AUTH_SESSION_MISSING"} storage=${STORAGE_STATE_PATH}`);
  if (!sessionLoaded) {
    console.error("AUTH_SESSION_INVALID: storageState missing. Please login manually and save storageState.");
    await browser.close();
    throw new Error("AUTH_SESSION_INVALID");
  }
  const startedAt = Date.now();
  let requestCount = 0;

  try {
    console.log(`[info] Inicio: listado Playwright + detalles Playwright (max ${maxPages})`);
    const listing = await fetchListingWithPlaywright(page);
    requestCount += 1;
    console.log(`[info] Listado obtenido desde ${listing.url}, html=${listing.html.length} chars`);
    console.log(`[info] Enlaces de detalle detectados: ${listing.links.length}`);
    const idBusListado = (listing as any).idBusqueda || null;

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
        // Lotes: obtener valor_subasta desde ver=3
        const lotUrl = buildLotUrl(page.url(), idBusListado);
        await safeWait(LOT_DELAY_MS);
        await page.goto(lotUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle");
        const lotHtml = await page.content();
        const lotVals = extractLotValues(lotHtml);
        const lotSum = lotVals.length ? lotVals.reduce((a, b) => a + b, 0) : null;
        const pdfLinks = [...extractPdfLinks(html, page.url()), ...extractPdfLinks(lotHtml, lotUrl)];

        // Volver a detalle para persistir el HTML enriquecido (opcional para coherencia visual)
        await page.goto(link.absolute, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle");
        const detailHtml = await page.content();

        const checksum = checksumSha256(detailHtml);
        const augmentedHtml =
          lotSum !== null
            ? `${detailHtml}\n<!-- lot_valor_subasta_sum=${lotSum.toFixed(2)} -->\n<div>Valor subasta (lotes): ${lotSum.toFixed(
                2
              )} €</div>\n`
            : detailHtml;

        const rawId = await persistRaw({ url: page.url(), payload: augmentedHtml, checksum, source: "BOE_DETAIL" });
        const boeUid = deriveBoeUid(page.url(), augmentedHtml);
        if (pdfLinks.length) {
          try {
            await downloadFirstPdf(boeUid, rawId, page, pdfLinks);
          } catch (err: any) {
            console.error(`[warn] PDF_ABORTED raw_id=${rawId} reason=${err?.message || err}`);
            throw err;
          }
        }
        console.log(
          `[info] detail_ok url=${page.url()} bytes=${detailHtml.length} lot_sum=${lotSum !== null ? lotSum.toFixed(2) : "null"}`
        );
      }
      requestCount += 1;
    }

    console.log("[info] SUCCESS: inserted listing+detail");
  } finally {
    await browser.close();
  }
}

