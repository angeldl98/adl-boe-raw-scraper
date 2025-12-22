const DEFAULT_BASE_URL = process.env.BOE_BASE_URL || 'https://subastas.boe.es';
const DEFAULT_TIMEOUT_MS = 10_000;
const UA = 'adl-boe-raw-scraper/0.1 (+https://adlsuite.com)';

export type RawFetchResult = {
  url: string;
  body: string;
};

export async function fetchRawOnce(): Promise<RawFetchResult> {
  const url = DEFAULT_BASE_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      signal: controller.signal
    });
    const body = await res.text();
    return { url, body };
  } finally {
    clearTimeout(timeout);
  }
}


