import { load, CheerioAPI } from "cheerio";
import { getClient } from "./db";
import { checksumSha256 } from "./checksum";

export type NormalizedSubasta = {
  url: string;
  identificador: string;
  tipoSubasta: string;
  importeDeposito?: string;
  valorSubasta?: string;
  checksum: string;
};

function textAfterLabel($: CheerioAPI, label: string): string | undefined {
  const match = $("*")
    .filter((_i, el) => $(el).text().trim().toLowerCase().startsWith(label.toLowerCase()))
    .first();
  if (!match || match.length === 0) return undefined;
  const sibling = match.next();
  const direct = sibling.text().trim();
  if (direct) return direct;
  return match.parent().find("td, dd, span").first().text().trim() || undefined;
}

function requiredFieldsPresent(n: NormalizedSubasta): boolean {
  return Boolean(n.identificador && n.tipoSubasta && (n.importeDeposito || n.valorSubasta));
}

export function parseDetailHtml(html: string, url: string): NormalizedSubasta | null {
  const $ = load(html);
  const identificador = textAfterLabel($, "Identificador") || "";
  const tipoSubasta = textAfterLabel($, "Tipo de subasta") || "";
  const importeDeposito = textAfterLabel($, "Importe del depósito");
  const valorSubasta = textAfterLabel($, "Valor subasta") || textAfterLabel($, "Valor de subasta");

  const normalized: NormalizedSubasta = {
    url,
    identificador: identificador.trim(),
    tipoSubasta: tipoSubasta.trim(),
    importeDeposito: importeDeposito?.trim(),
    valorSubasta: valorSubasta?.trim(),
    checksum: checksumSha256(html)
  };

  return requiredFieldsPresent(normalized) ? normalized : null;
}

export async function ensureNormalizedTable(): Promise<void> {
  const client = await getClient();
  await client.query(`
    CREATE TABLE IF NOT EXISTS boe_subastas_public (
      id SERIAL PRIMARY KEY,
      fuente TEXT NOT NULL DEFAULT 'BOE',
      normalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      url TEXT NOT NULL,
      identificador TEXT NOT NULL,
      tipo_subasta TEXT NOT NULL,
      importe_deposito TEXT,
      valor_subasta TEXT,
      checksum TEXT NOT NULL
    );
  `);
}

export async function persistNormalized(rows: NormalizedSubasta[]): Promise<void> {
  if (!rows.length) return;
  const client = await getClient();
  const values: any[] = [];
  const placeholders = rows
    .map((row, idx) => {
      const base = idx * 7;
      values.push(
        row.url,
        row.identificador,
        row.tipoSubasta,
        row.importeDeposito ?? null,
        row.valorSubasta ?? null,
        row.checksum,
        "BOE"
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    })
    .join(", ");

  await client.query(
    `
      INSERT INTO boe_subastas_public
        (url, identificador, tipo_subasta, importe_deposito, valor_subasta, checksum, fuente)
      VALUES ${placeholders}
    `,
    values
  );
}

export async function normalizeFromRaw(limit = 100): Promise<void> {
  const client = await getClient();
  const res = await client.query(
    `
      SELECT url, payload_raw AS html
      FROM boe_subastas_raw
      WHERE fuente = 'BOE_DETAIL'
      ORDER BY fetched_at DESC
      LIMIT $1
    `,
    [limit]
  );

  const parsed: NormalizedSubasta[] = [];
  for (const row of res.rows) {
    const norm = parseDetailHtml(row.html as string, row.url as string);
    if (norm) parsed.push(norm);
  }

  await ensureNormalizedTable();
  await persistNormalized(parsed);
  console.log(`[normalize] procesados ${parsed.length} registros (de ${res.rows.length} raw).`);
}

