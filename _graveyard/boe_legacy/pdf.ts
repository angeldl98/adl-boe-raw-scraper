import fs from "fs";
import path from "path";
import { checksumSha256 } from "./checksum";
import { getClient } from "./db";

const UA = "adl-boe-raw-scraper/0.1 (+https://adlsuite.com)";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PDFS = Math.max(1, Number(process.env.BOE_PDF_LIMIT || 1));
const DEST_ROOT = "/opt/adl-suite/data/boe/pdfs";

type PdfCandidate = {
  raw_id: number;
  boe_uid: string | null;
  url_detalle: string | null;
  payload_raw: string | null;
};

type DownloadedPdf = {
  raw_id: number;
  boe_uid: string | null;
  pdf_type: string | null;
  file_path: string;
  checksum: string;
};

function extractPdfUrl(html: string): { url: string; type: string | null } | null {
  // Look for explicit PDF links
  const pdfLink = html.match(/href=["']([^"']+\.pdf)["']/i);
  if (pdfLink?.[1]) return { url: pdfLink[1], type: "pdf" };
  // BOE often uses subastas_ava_doc.php?id=...
  const docLink = html.match(/href=["']([^"']*subastas_ava_doc\.php[^"']*)["']/i);
  if (docLink?.[1]) return { url: docLink[1], type: "documento" };
  return null;
}

async function selectPendingPdf(): Promise<PdfCandidate | null> {
  const client = await getClient();
  const res = await client.query<PdfCandidate>(
    `
      SELECT s.raw_id, s.boe_uid, s.url_detalle, r.payload_raw
      FROM boe_subastas s
      JOIN boe_subastas_raw r ON r.id = s.raw_id
      LEFT JOIN boe_subastas_pdfs p ON p.raw_id = s.raw_id
      WHERE p.raw_id IS NULL
      ORDER BY s.raw_id ASC
      LIMIT 1
    `
  );
  return res.rows[0] || null;
}

async function downloadPdf(url: string): Promise<{ buffer: Buffer; checksum: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const checksum = checksumSha256(buffer.toString("binary"));
    return { buffer, checksum };
  } finally {
    clearTimeout(timeout);
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function persistPdfMeta(pdf: DownloadedPdf): Promise<void> {
  const client = await getClient();
  await client.query(
    `
      INSERT INTO boe_subastas_pdfs (raw_id, boe_uid, pdf_type, file_path, checksum, fetched_at)
      VALUES ($1,$2,$3,$4,$5, now())
      ON CONFLICT (raw_id, checksum) DO NOTHING
    `,
    [pdf.raw_id, pdf.boe_uid, pdf.pdf_type, pdf.file_path, pdf.checksum]
  );
}

export async function fetchOnePdf(): Promise<boolean> {
  const candidate = await selectPendingPdf();
  if (!candidate) {
    console.log("pdf_fetch: no pending candidates");
    return false;
  }

  const html = candidate.payload_raw || "";
  const parsedLink = extractPdfUrl(html);
  const targetUrl = parsedLink?.url || candidate.url_detalle;
  if (!targetUrl) {
    console.warn("pdf_fetch: no pdf link found", { raw_id: candidate.raw_id, boe_uid: candidate.boe_uid });
    return false;
  }

  // polite pause
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    const { buffer, checksum } = await downloadPdf(targetUrl);
    const safeUid = candidate.boe_uid || `raw-${candidate.raw_id}`;
    const destDir = path.join(DEST_ROOT, safeUid);
    ensureDir(destDir);
    const filePath = path.join(destDir, `${checksum}.pdf`);
    fs.writeFileSync(filePath, buffer);
    await persistPdfMeta({
      raw_id: candidate.raw_id,
      boe_uid: candidate.boe_uid,
      pdf_type: parsedLink?.type || null,
      file_path: filePath,
      checksum
    });
    console.log("pdf_fetch_ok", { raw_id: candidate.raw_id, boe_uid: candidate.boe_uid, file_path: filePath });
    return true;
  } catch (err: any) {
    console.error("pdf_fetch_error", { raw_id: candidate.raw_id, boe_uid: candidate.boe_uid, error: err?.message });
    return false;
  }
}

export async function fetchPdfsOnce(): Promise<void> {
  let count = 0;
  if (MAX_PDFS <= 0) return;
  const ok = await fetchOnePdf();
  if (ok) count += 1;
  if (count >= MAX_PDFS) return;
}

