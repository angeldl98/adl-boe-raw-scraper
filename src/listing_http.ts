import { load, CheerioAPI, Element } from "cheerio";

const BASE_URL = process.env.BOE_BASE_URL || "https://subastas.boe.es";
const LISTING_URL = `${BASE_URL}/subastas_ava.php`;
const UA =
  process.env.BOE_HTTP_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const RESULT_SELECTOR = "li.resultado-busqueda a.resultado-busqueda-link-defecto";

type FormField = { name: string; value: string | string[] };

type SearchForm = {
  action: string;
  method: string;
  fields: FormField[];
  submit?: { name?: string; value?: string };
};

export type ListingLink = {
  href: string;
  absolute: string;
  text: string;
};

export type ListingFetchResult = {
  html: string;
  url: string;
  links: ListingLink[];
};

function absoluteUrl(href: string | undefined): string {
  if (!href) return LISTING_URL;
  try {
    return new URL(href, LISTING_URL).toString();
  } catch {
    return LISTING_URL;
  }
}

function normalizeCookieHeader(headers: Headers): string | undefined {
  const anyHeaders = headers as any;
  const rawCookies: Array<string | null | undefined> | undefined =
    anyHeaders.getSetCookie?.() ||
    anyHeaders.raw?.()["set-cookie"] ||
    (headers.get("set-cookie") ? [headers.get("set-cookie")] : undefined);

  if (!rawCookies || rawCookies.length === 0) return undefined;
  const parts = rawCookies
    .flatMap((c: string | null | undefined) => (c ? c.split(",") : []))
    .map((c: string) => c.split(";")[0]);
  const cleaned = parts.filter(Boolean);
  return cleaned.length ? cleaned.join("; ") : undefined;
}

function extractSearchForm(html: string): SearchForm | null {
  const $: CheerioAPI = load(html);
  const candidates = $("form").filter((_idx: number, el: Element) => {
    const action = ($(el).attr("action") || "").toLowerCase();
    return action.includes("subastas_ava");
  });
  const form = candidates.length ? candidates.first() : $("form").first();
  if (!form || form.length === 0) return null;

  const fields: FormField[] = [];
  form.find("input, select, textarea").each((_idx: number, el: Element) => {
    const name = $(el).attr("name");
    if (!name) return;
    const type = ($(el).attr("type") || "").toLowerCase();
    if (type === "submit" || type === "button") return;
    if (type === "checkbox" || type === "radio") {
      const checked = $(el).is(":checked");
      if (!checked) return;
    }
    const rawVal = $(el).val();
    if (Array.isArray(rawVal)) {
      fields.push({ name, value: rawVal.map((v) => (v ?? "").toString()) });
    } else if (rawVal !== undefined && rawVal !== null) {
      fields.push({ name, value: (rawVal as string | number | boolean).toString() });
    } else {
      fields.push({ name, value: "" });
    }
  });

  const submitCandidate = form
    .find("input[type='submit'], button[type='submit'], button")
    .filter((_idx: number, el: Element) => {
      const label = ($(el).attr("value") || $(el).text() || "").toLowerCase();
      return label.includes("buscar");
    })
    .first();

  const submit =
    submitCandidate && submitCandidate.length && submitCandidate.attr("name")
      ? { name: submitCandidate.attr("name"), value: submitCandidate.attr("value") || "Buscar" }
      : undefined;

  return {
    action: absoluteUrl(form.attr("action") || LISTING_URL),
    method: (form.attr("method") || "POST").toUpperCase(),
    fields,
    submit
  };
}

function buildBody(form: SearchForm): URLSearchParams {
  const params = new URLSearchParams();
  for (const field of form.fields) {
    if (Array.isArray(field.value)) {
      field.value.forEach((v) => params.append(field.name, v ?? ""));
    } else {
      params.append(field.name, field.value ?? "");
    }
  }
  if (form.submit?.name) {
    params.append(form.submit.name, form.submit.value ?? "Buscar");
  }
  return params;
}

export function extractDetailLinks(html: string): ListingLink[] {
  const $: CheerioAPI = load(html);
  const seen = new Set<string>();
  const links: ListingLink[] = [];
  $(RESULT_SELECTOR).each((_idx: number, el: Element) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = absoluteUrl(href);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const text = $(el).text().replace(/\s+/g, " ").trim();
    links.push({ href, absolute, text });
  });
  return links;
}

export async function fetchListingPage(): Promise<ListingFetchResult> {
  const initial = await fetch(LISTING_URL, {
    method: "GET",
    headers: { "User-Agent": UA }
  });

  const initialHtml = await initial.text();
  const cookieHeader = normalizeCookieHeader(initial.headers);
  const form = extractSearchForm(initialHtml);
  if (!form) {
    throw new Error("No se encontró el formulario de búsqueda en la página de subastas.");
  }

  const body = buildBody(form);
  const res = await fetch(form.action, {
    method: form.method || "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    body
  });

  const html = await res.text();
  const url = res.url || form.action;
  const links = extractDetailLinks(html);

  return { html, url, links };
}

