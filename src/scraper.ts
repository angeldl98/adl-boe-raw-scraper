import { chromium, Browser, Page, Locator } from "playwright";
import { ListingLink } from "./listing_http";
import { checksumSha256, domFingerprint } from "./checksum";
import { persistRaw } from "./persist";
import { getClient, closeClient } from "./db";
import fs from "fs";
import path from "path";
import { URL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
// PDF parsing intentionally removed from raw stage.
// Parsing will be handled by normalizer/analyst.
const DISABLE_PDF_PARSE = process.env.DISABLE_PDF_PARSE === "true";

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
const PDF_DELAY_MIN_MS = Number(process.env.BOE_PDF_DELAY_MIN_MS || 3000);
const PDF_DELAY_MAX_MS = Number(process.env.BOE_PDF_DELAY_MAX_MS || 6000);
const PDF_MAX_BYTES = 15 * 1024 * 1024; // 15MB límite duro
const PDF_TIMEOUT_MS = 30_000; // 30s por PDF
const STORAGE_STATE_PATH = process.env.BOE_STORAGE_STATE || "/opt/adl-suite/data/boe_auth/storageState.json";
const STORAGE_STATE_DIR = path.dirname(STORAGE_STATE_PATH);
const BOE_LOGIN_URL = process.env.BOE_LOGIN_URL || "https://subastas.boe.es/login.php";
const BOE_PROXY = process.env.BOE_PROXY || "";
const DEBUG_DIR = process.env.BOE_DEBUG_DIR || "/opt/adl-suite/data/boe_debug";

const PDF_BUDGET = Number.isFinite(Number(process.env.BOE_PDF_DAILY_BUDGET))
  ? Math.max(Number(process.env.BOE_PDF_DAILY_BUDGET), 0)
  : 20;
const PDF_MAX_DAYS_AHEAD = Number.isFinite(Number(process.env.BOE_PDF_MAX_DAYS_AHEAD))
  ? Math.max(Number(process.env.BOE_PDF_MAX_DAYS_AHEAD), 1)
  : 45;
const PDF_ONLY_ACTIVE = (process.env.BOE_PDF_ONLY_ACTIVE || "true").toLowerCase() === "true";
const PDF_ONLY_INMUEBLE = (process.env.BOE_PDF_ONLY_INMUEBLE || "true").toLowerCase() === "true";
const PDF_DRY_RUN = (process.env.BOE_PDF_DRY_RUN || "false").toLowerCase() === "true";
const QUEUE_LIMIT = 200;
const SEARCH_DAYS_BACK = Number.isFinite(Number(process.env.BOE_SEARCH_DAYS_BACK))
  ? Math.max(Number(process.env.BOE_SEARCH_DAYS_BACK), 0)
  : 30;
const ZERO_RESULT_WAIT_MS = Number.isFinite(Number(process.env.BOE_ZERO_RESULT_WAIT_MS))
  ? Math.max(Number(process.env.BOE_ZERO_RESULT_WAIT_MS), 1000)
  : 30_000;
const MAX_CANDIDATES = Number.isFinite(Number(process.env.BOE_MAX_CANDIDATES))
  ? Math.max(1, Number(process.env.BOE_MAX_CANDIDATES))
  : 100;
const INFER_LOOKBACK = Number.isFinite(Number(process.env.BOE_INFER_LOOKBACK))
  ? Math.max(1, Number(process.env.BOE_INFER_LOOKBACK))
  : 50;

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

function randomDelay(minMs: number, maxMs: number): number {
  const delta = Math.max(maxMs - minMs, 0);
  return minMs + Math.floor(Math.random() * (delta + 1));
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
    console.log("[BOE] No results found. Capturing debug artifacts and retrying soon.");
    await captureZeroResults(page, "no_links_after_search");
    await safeWait(30 * 1000);
    return [];
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
  const end = addDays(new Date(), PDF_MAX_DAYS_AHEAD);
  const start = addDays(new Date(), -SEARCH_DAYS_BACK);

  await page.goto(LISTING_URL, { waitUntil: "domcontentloaded" });
  await acceptCookies(page).catch(() => {});
  await clearProvince(page);
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

async function captureZeroResults(page: Page, reason: string): Promise<{ htmlPath: string; screenshotPath: string }> {
  ensureDir(DEBUG_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const htmlPath = path.join(DEBUG_DIR, `listing-${ts}.html`);
  const screenshotPath = path.join(DEBUG_DIR, `listing-${ts}.png`);
  const html = await page.content();
  fs.writeFileSync(htmlPath, html, "utf8");
  let shot = "";
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    shot = screenshotPath;
  } catch (err: any) {
    console.warn(`[debug] screenshot failed reason=${err?.message || err}`);
  }
  console.log(
    `[debug] ZERO_RESULTS_CAPTURE reason=${reason} url=${page.url()} html_len=${html.length} html=${htmlPath} screenshot=${shot || "none"}`
  );
  return { htmlPath, screenshotPath: shot };
}

type CandidateSource = "dom" | "xhr" | "inferred";
type Candidate = { url: string; source: CandidateSource };

function normalizeDetailUrl(urlStr: string): string | null {
  try {
    const u = new URL(urlStr, BASE_URL);
    if (!u.pathname.includes("detalleSubasta.php")) return null;
    if (!u.searchParams.get("idSub")) return null;
    u.searchParams.set("ver", u.searchParams.get("ver") || "1");
    return u.toString();
  } catch {
    return null;
  }
}

function extractIdSub(urlStr: string): string | null {
  try {
    const u = new URL(urlStr, BASE_URL);
    return u.searchParams.get("idSub");
  } catch {
    return null;
  }
}

async function collectNetworkCandidates(page: Page): Promise<Set<string>> {
  const urls = new Set<string>();
  page.on("response", (resp) => {
    try {
      const url = resp.url();
      if (
        url.includes("detalleSubasta") ||
        url.includes("subastas_ava") ||
        url.includes("subastas")
      ) {
        const norm = normalizeDetailUrl(url);
        if (norm) urls.add(norm);
      }
    } catch {
      /* ignore */
    }
  });
  return urls;
}

async function collectInferredCandidates(): Promise<Set<string>> {
  const urls = new Set<string>();
  const client = await getClient();
  const res = await client.query(
    `SELECT url FROM boe_subastas_raw WHERE url LIKE '%idSub=%' ORDER BY fetched_at DESC LIMIT $1`,
    [INFER_LOOKBACK]
  );
  const seenPrefixes = new Set<string>();
  for (const row of res.rows) {
    const id = extractIdSub(row.url);
    if (!id) continue;
    const m = id.match(/(SUB-[A-Z]{2}-\d{4})-(\d+)/i);
    if (!m) continue;
    const prefix = m[1];
    const num = Number(m[2]);
    if (!Number.isFinite(num)) continue;
    seenPrefixes.add(prefix);
    for (const delta of [1, 2]) {
      const next = `${prefix}-${num + delta}`;
      const url = `${BASE_URL}/detalleSubasta.php?idSub=${encodeURIComponent(next)}`;
      urls.add(url);
    }
  }

  // Validate inferred URLs with lightweight GET
  const valid = new Set<string>();
  for (const u of urls) {
    try {
      const resp = await fetch(u, { method: "GET" });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text && text.length > 500) valid.add(normalizeDetailUrl(u) as string);
    } catch {
      continue;
    }
  }
  return valid;
}

function validateDetailHtml(html: string, url: string): { ok: boolean; reason?: string } {
  const boeUid = deriveBoeUid(url, html);
  if (!boeUid) return { ok: false, reason: "missing_boe_uid" };
  const fecha = parseDateFromDetail(html);
  if (!fecha) return { ok: false, reason: "missing_date" };
  const tipo = extractTipoBien(html);
  if (!tipo) return { ok: false, reason: "missing_tipo" };
  const authorityMatch = html.match(/Juzgado|Órgano|Autoridad|Entidad/i);
  if (!authorityMatch) return { ok: false, reason: "missing_authority" };
  return { ok: true };
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

async function ensurePdfSignalsTable() {
  const client = await getClient();
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS boe_aux;
    CREATE TABLE IF NOT EXISTS boe_aux.pdf_signals (
      subasta_id INT PRIMARY KEY,
      boe_uid TEXT,
      has_cargas_mencionadas BOOLEAN,
      procedimiento TEXT,
      juzgado TEXT,
      extract_ok BOOLEAN,
      extract_reason TEXT,
      extracted_at TIMESTAMPTZ DEFAULT now(),
      file_path TEXT,
      checksum TEXT
    );
  `);
}

async function downloadFirstPdf(
  boeUid: string | null,
  rawId: number | null,
  page: Page,
  links: string[]
): Promise<{ filePath: string; checksum: string; buffer: Buffer } | null> {
  if (!boeUid) return null;
  if (!links.length) return null;
  const pdfUrl = links[0];
  await safeWait(randomDelay(PDF_DELAY_MIN_MS, PDF_DELAY_MAX_MS));

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
  return { filePath, checksum, buffer };
}

function parseEuroToNumber(val: string | null | undefined): number | null {
  if (!val) return null;
  const cleaned = val.replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseDateFromDetail(html: string): Date | null {
  const m = html.match(/Fecha[^<]{0,40}fin[^<]{0,20}:\s*<\/td>\s*<td[^>]*>\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
  if (!m) return null;
  const [d, mo, y] = m[1].split("/").map(Number);
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function extractTipoBien(html: string): string | null {
  const m = html.match(/Tipo\s+de\s+bien<\/th>\s*<td[^>]*>\s*([^<]+)/i);
  if (m?.[1]) return m[1].trim();
  const m2 = html.match(/Tipo\s+de\s+Subasta<\/th>\s*<td[^>]*>\s*([^<]+)/i);
  if (m2?.[1]) return m2[1].trim();
  return null;
}

function isInmuebleHeuristic(tipo: string | null, html: string): boolean {
  const txt = ((tipo || "") + " " + html).toLowerCase();
  return (
    txt.includes("inmueble") ||
    txt.includes("vivienda") ||
    txt.includes("piso") ||
    txt.includes("garaje") ||
    txt.includes("trastero") ||
    txt.includes("local") ||
    txt.includes("urbano") ||
    txt.includes("rustico") ||
    txt.includes("suelo")
  );
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

function extractSignalsFromText(text: string): { hasCargas: boolean; procedimiento: string | null; juzgado: string | null } {
  const lower = text.toLowerCase();
  const hasCargas =
    lower.includes("carga") ||
    lower.includes("hipoteca") ||
    lower.includes("embargo") ||
    lower.includes("gravamen") ||
    lower.includes("preferente");
  const procMatch = text.match(/(ejecuci[oó]n hipotecaria|ejecuci[oó]n|procedimiento [a-zA-Z ]{3,30})/i);
  const juzMatch = text.match(/Juzgado[^,\n]{0,60}/i);
  return {
    hasCargas,
    procedimiento: procMatch ? procMatch[1] : null,
    juzgado: juzMatch ? juzMatch[0] : null
  };
}

async function persistPdfSignals(
  subastaId: number | null,
  boeUid: string | null,
  filePath: string,
  checksum: string,
  signals: { hasCargas: boolean; procedimiento: string | null; juzgado: string | null; ok: boolean; reason?: string }
) {
  if (subastaId === null) return;
  const client = await getClient();
  await ensurePdfSignalsTable();
  await client.query(
    `
      INSERT INTO boe_aux.pdf_signals
        (subasta_id, boe_uid, has_cargas_mencionadas, procedimiento, juzgado, extract_ok, extract_reason, file_path, checksum, extracted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      ON CONFLICT (subasta_id) DO UPDATE SET
        boe_uid = EXCLUDED.boe_uid,
        has_cargas_mencionadas = EXCLUDED.has_cargas_mencionadas,
        procedimiento = EXCLUDED.procedimiento,
        juzgado = EXCLUDED.juzgado,
        extract_ok = EXCLUDED.extract_ok,
        extract_reason = EXCLUDED.extract_reason,
        file_path = EXCLUDED.file_path,
        checksum = EXCLUDED.checksum,
        extracted_at = now()
    `,
    [subastaId, boeUid, signals.hasCargas, signals.procedimiento, signals.juzgado, signals.ok, signals.reason || null, filePath, checksum]
  );
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
  const runClient = await getClient();
  await runClient.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  await runClient.query(`
    CREATE TABLE IF NOT EXISTS public.pipeline_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pipeline TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      stats JSONB DEFAULT '{}'::jsonb,
      error TEXT
    )
  `);
  const runRes = await runClient.query(
    `INSERT INTO pipeline_runs (pipeline, status, started_at, stats) VALUES ($1, 'running', now(), '{}'::jsonb) RETURNING id`,
    ["boe-raw"]
  );
  const runId: string = runRes.rows[0].id;
  const runStats: Record<string, unknown> = {
    listing_links: 0,
    listing_html_len: 0,
    details_ok: 0,
    queued: 0,
    eligible: 0,
    pdf_downloaded: 0,
    pdf_failed: 0,
    pdf_skipped: 0,
    found_dom: 0,
    found_xhr: 0,
    found_inferred: 0,
    validated: 0,
    discarded: 0,
    mode: "normal",
    evidence_html: "",
    evidence_screenshot: "",
    dom_fingerprint: "",
    candidate_count_total: 0
  };

  try {
    console.log(`[info] Inicio: listado Playwright + detalles Playwright (max ${maxPages})`);
    const xhrCandidates = await collectNetworkCandidates(page);
    const listing = await fetchListingWithPlaywright(page);
    requestCount += 1;
    console.log(`[info] Listado obtenido desde ${listing.url}, html=${listing.html.length} chars`);
    console.log(`[info] Enlaces de detalle detectados: ${listing.links.length}`);
    const idBusListado = (listing as any).idBusqueda || null;
    runStats.listing_links = listing.links.length;
    runStats.listing_html_len = listing.html.length;
    runStats.found_dom = listing.links.length;
    runStats.found_xhr = xhrCandidates.size;

    // Método C: inferencia por continuidad
    const inferred = await collectInferredCandidates();
    runStats.found_inferred = inferred.size;

    // Pool de candidatos
    const candidatePool = new Map<string, Candidate>();
    const pushCandidate = (url: string, source: CandidateSource) => {
      if (!url) return;
      const norm = normalizeDetailUrl(url);
      if (!norm) return;
      if (candidatePool.size >= MAX_CANDIDATES && !candidatePool.has(norm)) return;
      if (!candidatePool.has(norm)) candidatePool.set(norm, { url: norm, source });
    };

    listing.links.forEach((l) => pushCandidate(l.absolute, "dom"));
    xhrCandidates.forEach((u) => pushCandidate(u, "xhr"));
    inferred.forEach((u) => pushCandidate(u, "inferred"));
    runStats.candidate_count_total = candidatePool.size;

    if (!options.dryRun && candidatePool.size > 0) {
      const listingChecksum = checksumSha256(listing.html);
      await persistRaw({ url: listing.url, payload: listing.html, checksum: listingChecksum, source: "BOE_LISTING" });
    }

    if (candidatePool.size === 0) {
      console.log("[BOE] No candidates from DOM/XHR/inferred. Degraded mode.");
      runStats.mode = "degraded";
      const capture = await captureZeroResults(page, "no_candidates");
      runStats.evidence_html = capture.htmlPath;
      runStats.evidence_screenshot = capture.screenshotPath;
      runStats.dom_fingerprint = domFingerprint(listing.html);
      await runClient.query(
        `UPDATE pipeline_runs SET status='degraded', finished_at=now(), stats=$2 WHERE id=$1`,
        [runId, JSON.stringify(runStats)]
      );
      await safeWait(ZERO_RESULT_WAIT_MS);
      return;
    }

    const selectedCandidates = Array.from(candidatePool.values()).slice(0, maxDetails);
    const selected: ListingLink[] = selectedCandidates.map((c) => ({
      absolute: c.url,
      href: c.url,
      text: ""
    }));
    const detailRecords: Array<{
      link: ListingLink;
      rawId: number;
      boeUid: string | null;
      pdfLinks: string[];
      lotSum: number | null;
      fechaFin: Date | null;
      tipo: string | null;
      subastaId: number | null;
    }> = [];

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

      const boeUid = deriveBoeUid(page.url(), augmentedHtml);
      const fechaFin = parseDateFromDetail(augmentedHtml);
      const tipo = extractTipoBien(augmentedHtml);
      const subastaId = parseInt(new URL(page.url()).searchParams.get("idSub") || "", 10);
      const validation = validateDetailHtml(augmentedHtml, page.url());
      if (!validation.ok) {
        runStats.discarded = (runStats.discarded as number) + 1;
        console.warn(`[warn] detail_discarded reason=${validation.reason || "unknown"} url=${page.url()}`);
        continue;
      }
      runStats.validated = (runStats.validated as number) + 1;

      const rawId = options.dryRun ? -1 : await persistRaw({ url: page.url(), payload: augmentedHtml, checksum, source: "BOE_DETAIL" });
      detailRecords.push({
        link,
        rawId,
        boeUid,
        pdfLinks,
        lotSum,
        fechaFin,
        tipo,
        subastaId: Number.isFinite(subastaId) ? subastaId : null
      });
      console.log(
        `[info] detail_ok url=${page.url()} bytes=${detailHtml.length} lot_sum=${lotSum !== null ? lotSum.toFixed(2) : "null"}`
      );

      requestCount += 1;
    }
    runStats.details_ok = detailRecords.length;

    // Cola priorizada de PDFs
    const nowDate = new Date();
    const windowEnd = addDays(nowDate, PDF_MAX_DAYS_AHEAD);
    const queue = detailRecords
      .filter((d) => {
        if (!d.pdfLinks.length) return false;
        if (PDF_ONLY_INMUEBLE && !isInmuebleHeuristic(d.tipo, "")) return false;
        if (d.fechaFin && d.fechaFin > windowEnd) return false;
        return true;
      })
      .slice(0, QUEUE_LIMIT)
      .sort((a, b) => {
        const da = a.fechaFin ? a.fechaFin.getTime() : Number.MAX_SAFE_INTEGER;
        const db = b.fechaFin ? b.fechaFin.getTime() : Number.MAX_SAFE_INTEGER;
        if (da !== db) return da - db;
        const va = a.lotSum || 0;
        const vb = b.lotSum || 0;
        return vb - va;
      });

    console.log(
      `QUEUE | listed_total=${selected.length} | eligible=${queue.length} | queued=${queue.length} | window_days=${PDF_MAX_DAYS_AHEAD}`
    );
    runStats.queued = queue.length;
    runStats.eligible = queue.length;

    let budget = PDF_BUDGET;
    let pdfDownloaded = 0;
    let pdfFailed = 0;
    let pdfSkipped = 0;

    for (const item of queue) {
      if (budget <= 0) break;
      if (!item.boeUid || !item.pdfLinks.length) {
        pdfSkipped += 1;
        continue;
      }
      if (PDF_DRY_RUN) {
        console.log(`PDF_WOULD_DOWNLOAD boe_uid=${item.boeUid} subasta_id=${item.subastaId || "null"} url=${item.pdfLinks[0]}`);
        budget -= 1;
        pdfSkipped += 1;
        continue;
      }
      await safeWait(randomDelay(PDF_DELAY_MIN_MS, PDF_DELAY_MAX_MS));
      try {
        const downloaded = await downloadFirstPdf(item.boeUid, item.rawId, page, item.pdfLinks);
        if (downloaded) {
          pdfDownloaded += 1;
          budget -= 1;
          // PDF parsing disabled at raw stage to avoid DOM dependency. Parsing will be handled by normalizer/analyst.
          const text = "";
          const signals = extractSignalsFromText(text || "");
          await persistPdfSignals(item.subastaId, item.boeUid, downloaded.filePath, downloaded.checksum, {
            hasCargas: signals.hasCargas,
            procedimiento: signals.procedimiento,
            juzgado: signals.juzgado,
            ok: true
          });
        } else {
          pdfSkipped += 1;
        }
      } catch (err: any) {
        pdfFailed += 1;
        budget -= 1;
        console.error(`[warn] PDF_FAIL boe_uid=${item.boeUid} reason=${err?.message || err}`);
        if (item.subastaId) {
          await persistPdfSignals(item.subastaId, item.boeUid, "", "", {
            hasCargas: false,
            procedimiento: null,
            juzgado: null,
            ok: false,
            reason: err?.message || "pdf_fail"
          });
        }
      }
    }
    runStats.pdf_downloaded = pdfDownloaded;
    runStats.pdf_failed = pdfFailed;
    runStats.pdf_skipped = pdfSkipped;

    console.log(
      `RUN_OK | listed=${candidatePool.size} | eligible=${queue.length} | queued=${queue.length} | pdf_downloaded=${pdfDownloaded} | pdf_failed=${pdfFailed} | pdf_skipped=${pdfSkipped} | dry_run=${PDF_DRY_RUN}`
    );
    const allValidated = (runStats.validated as number) > 0;
    const hadCandidates = (runStats.candidate_count_total as number) > 0;
    if (!allValidated && hadCandidates) {
      runStats.mode = "degraded";
      await runClient.query(
        `UPDATE pipeline_runs SET status='degraded', finished_at=now(), stats=$2 WHERE id=$1`,
        [runId, JSON.stringify(runStats)]
      );
    } else {
      await runClient.query(
        `UPDATE pipeline_runs SET status='ok', finished_at=now(), stats=$2 WHERE id=$1`,
        [runId, JSON.stringify(runStats)]
      );
    }
  } catch (err: any) {
    const hadCandidates = (runStats.candidate_count_total as number) > 0;
    const validationOnly =
      typeof err?.message === "string" && err.message.startsWith("DETAIL_VALIDATION_FAILED");
    const noneValidated = (runStats.validated as number) === 0;
    if (hadCandidates && noneValidated && validationOnly) {
      runStats.mode = "degraded";
      await runClient.query(
        `UPDATE pipeline_runs SET status='degraded', finished_at=now(), stats=$2 WHERE id=$1`,
        [runId, JSON.stringify(runStats)]
      );
    } else {
      await runClient.query(
        `UPDATE pipeline_runs SET status='error', finished_at=now(), stats=$3, error=$2 WHERE id=$1`,
        [runId, String(err?.message || err), JSON.stringify(runStats)]
      );
      throw err;
    }
  } finally {
    await browser.close();
    await closeClient();
  }
}

