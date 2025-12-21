import "dotenv/config";
import { fetchRawOnce } from "./fetch";
import { checksumSha256 } from "./checksum";
import { persistRaw } from "./persist";
import { closeClient } from "./db";

async function main() {
  console.log("adl-boe-raw-scraper starting");
  const fetched = await fetchRawOnce();
  const checksum = checksumSha256(fetched.body);
  await persistRaw({ url: fetched.url, payload: fetched.body, checksum });
  console.log("adl-boe-raw-scraper success");
}

main()
  .then(() => closeClient().catch(() => {}).finally(() => process.exit(0)))
  .catch(err => {
    console.error(err);
    closeClient().finally(() => process.exit(1));
  });


