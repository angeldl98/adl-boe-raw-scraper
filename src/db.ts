import { Client } from "pg";

let client: Client | null = null;

export async function getClient(): Promise<Client> {
  if (client) return client;

  const connectionString = process.env.DATABASE_URL;
  client = new Client(
    connectionString
      ? { connectionString }
      : {
          host: process.env.PGHOST,
          port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE
        }
  );

  await client.connect();
  return client;
}

export async function closeClient(): Promise<void> {
  if (client) {
    await client.end().catch(() => {});
    client = null;
  }
}


