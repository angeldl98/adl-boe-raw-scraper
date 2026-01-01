import { createHash } from "crypto";

export function checksumSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function domFingerprint(html: string): string {
  const normalized = html.replace(/\s+/g, " ").trim();
  return checksumSha256(normalized);
}


