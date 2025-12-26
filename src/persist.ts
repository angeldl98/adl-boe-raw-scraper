import { getClient } from "./db";

export type RawPersistInput = {
  url: string;
  payload: string;
  checksum: string;
  source?: string;
};

export async function persistRaw(input: RawPersistInput): Promise<number> {
  const client = await getClient();
  const source = input.source ?? "BOE";
  const res = await client.query(
    `
      INSERT INTO boe_subastas_raw (fuente, fetched_at, url, payload_raw, checksum)
      VALUES ($1, NOW(), $2, $3, $4)
      RETURNING id
    `,
    [source, input.url, input.payload, input.checksum]
  );
  return res.rows?.[0]?.id ?? 0;
}


