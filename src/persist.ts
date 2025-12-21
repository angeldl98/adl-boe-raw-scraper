import { getClient } from "./db";

export type RawPersistInput = {
  url: string;
  payload: string;
  checksum: string;
};

export async function persistRaw(input: RawPersistInput): Promise<void> {
  const client = await getClient();
  await client.query(
    `
      INSERT INTO boe_subastas_raw (fuente, fetched_at, url, payload_raw, checksum)
      VALUES ($1, NOW(), $2, $3, $4)
    `,
    ['BOE', input.url, input.payload, input.checksum]
  );
}


