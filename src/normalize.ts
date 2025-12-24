import { load, CheerioAPI } from "cheerio";
import { getClient } from "./db";
import { checksumSha256 } from "./checksum";

export type NormalizedSubasta = {
  url: string;
  identificador: string;
  tipoSubasta: string;
  estado: string | null;
  estadoDetalle: string | null;
  valorSubasta: string | null;
  tasacion: string | null;
  importeDeposito: string | null;
  checksum: string;
};

function getValueByTh($: CheerioAPI, label: string): string | null {
  const cell = $("th")
    .filter((_i, el) => $(el).text().trim().toLowerCase() === label.toLowerCase())
    .first()
    .closest("tr")
    .find("td")
    .first();
  const text = cell.text().trim();
  return text || null;
}

function requiredFieldsPresent(n: NormalizedSubasta): boolean {
  return Boolean(n.identificador && n.tipoSubasta && (n.valorSubasta || n.tasacion));
}

export function parseDetailHtml(html: string, url: string): NormalizedSubasta | null {
  const $ = load(html);
  const identificador = getValueByTh($, "Identificador") || "";
  const tipoSubasta = getValueByTh($, "Tipo de subasta") || "";
  const valorSubasta = getValueByTh($, "Valor subasta");
  const tasacion = getValueByTh($, "Tasación");
  const importeDeposito = getValueByTh($, "Importe del depósito");
  const aviso = $(".caja.gris.aviso").text().trim();
  const estadoDetalle = aviso ? aviso.replace(/\s+/g, " ").trim() : null;
  const avisoLower = (estadoDetalle || "").toLowerCase();
  let estado: string | null = "Activa";
  if (avisoLower.includes("cancelad")) estado = "Cancelada";
  else if (avisoLower.includes("finaliz")) estado = "Finalizada";

  const normalized: NormalizedSubasta = {
    url,
    identificador: identificador.trim(),
    tipoSubasta: tipoSubasta.trim(),
    estado,
    estadoDetalle,
    valorSubasta: valorSubasta?.trim() || null,
    tasacion: tasacion?.trim() || null,
    importeDeposito: importeDeposito?.trim() || null,
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
      estado TEXT,
      estado_detalle TEXT,
      valor_subasta TEXT,
      tasacion TEXT,
      importe_deposito TEXT,
      checksum TEXT NOT NULL,
      CONSTRAINT boe_identificador_unique UNIQUE (identificador)
    );

    CREATE TABLE IF NOT EXISTS boe_subastas (
      id SERIAL PRIMARY KEY,
      normalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      url TEXT NOT NULL,
      identificador TEXT NOT NULL UNIQUE,
      tipo_subasta TEXT NOT NULL,
      estado TEXT,
      estado_detalle TEXT,
      valor_subasta TEXT,
      tasacion TEXT,
      importe_deposito TEXT,
      organismo TEXT,
      provincia TEXT,
      municipio TEXT,
      checksum TEXT NOT NULL
    );
  `);
}

export async function persistNormalized(rows: NormalizedSubasta[]): Promise<void> {
  if (!rows.length) return;
  const client = await getClient();
  const values: any[] = [];
  const placeholders: string[] = [];
  rows.forEach((row) => {
    values.push(
      row.url,
      row.identificador,
      row.tipoSubasta,
      row.valorSubasta ?? null,
      row.tasacion ?? null,
      row.importeDeposito ?? null,
      row.estado,
      row.estadoDetalle ?? null,
      row.checksum
    );
    const base = values.length - 9;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
    );
  });

  await client.query(
    `
      INSERT INTO boe_subastas_public
        (url, identificador, tipo_subasta, valor_subasta, tasacion, importe_deposito, estado, estado_detalle, checksum)
      VALUES ${placeholders}
      ON CONFLICT (identificador)
      DO UPDATE SET
        tipo_subasta = EXCLUDED.tipo_subasta,
        estado = EXCLUDED.estado,
        estado_detalle = EXCLUDED.estado_detalle,
        valor_subasta = EXCLUDED.valor_subasta,
        tasacion = EXCLUDED.tasacion,
        importe_deposito = EXCLUDED.importe_deposito,
        checksum = EXCLUDED.checksum,
        normalized_at = NOW()
    `,
    values
  );

  // Also persist canonical NORM table boe_subastas
  await client.query(
    `
      INSERT INTO boe_subastas
        (url, identificador, tipo_subasta, valor_subasta, tasacion, importe_deposito, estado, estado_detalle, checksum)
      VALUES ${placeholders}
      ON CONFLICT (identificador)
      DO UPDATE SET
        tipo_subasta = EXCLUDED.tipo_subasta,
        estado = EXCLUDED.estado,
        estado_detalle = EXCLUDED.estado_detalle,
        valor_subasta = EXCLUDED.valor_subasta,
        tasacion = EXCLUDED.tasacion,
        importe_deposito = EXCLUDED.importe_deposito,
        checksum = EXCLUDED.checksum,
        normalized_at = NOW()
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

  // Deduplicate by identificador (newest wins).
  const byId = new Map<string, NormalizedSubasta>();
  for (const row of parsed) {
    byId.set(row.identificador, row);
  }
  const deduped = Array.from(byId.values());

  await ensureNormalizedTable();
  await persistNormalized(deduped);
  console.log(`[normalize] procesados ${deduped.length} registros (de ${res.rows.length} raw, ${parsed.length} válidos antes de dedup).`);
}

