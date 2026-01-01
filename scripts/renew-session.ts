#!/usr/bin/env tsx

/**
 * BOE Session Renewal Script
 *
 * Purpose: Manually renew BOE session cookies when they expire.
 * Usage: npm run renew-session
 *
 * This script:
 * - Opens browser in headed mode for manual login
 * - Waits for user to complete login
 * - Saves cookies to storageState.json
 * - Should be run MANUALLY when session expires
 *
 * DO NOT automate this script - risk of IP ban.
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs/promises";

const STORAGE_STATE_PATH =
  process.env.BOE_STORAGE_STATE_PATH ||
  "/opt/adl-suite/data/boe_auth/storageState.json";

const BOE_LOGIN_URL = "https://subastas.boe.es/";

async function renewSession() {
  console.log("🔐 BOE Session Renewal");
  console.log("=====================");
  console.log(`Storage path: ${STORAGE_STATE_PATH}`);
  console.log("");

  // Backup existing session if it exists
  try {
    const existingState = await fs.readFile(STORAGE_STATE_PATH, "utf-8");
    const backupPath = `${STORAGE_STATE_PATH}.backup.${Date.now()}`;
    await fs.writeFile(backupPath, existingState);
    console.log(`✓ Backed up existing session to: ${backupPath}`);
  } catch (_err) {
    console.log("ℹ No existing session to backup");
  }

  console.log("");
  console.log("🌐 Opening browser for manual login...");
  console.log("");
  console.log("INSTRUCTIONS:");
  console.log("1. A browser window will open");
  console.log("2. Log in to BOE manually");
  console.log("3. Navigate to a protected page to verify login works");
  console.log("4. Return to this terminal and press ENTER when done");
  console.log("");

  const browser = await chromium.launch({
    headless: false, // MUST be headed for manual login
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
  });

  const page = await context.newPage();
  await page.goto(BOE_LOGIN_URL);

  console.log("✓ Browser opened");
  console.log("");
  console.log("⏳ Waiting for you to complete login...");
  console.log("Press ENTER when you have successfully logged in:");

  // Wait for user input
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => {
      resolve();
    });
  });

  console.log("");
  console.log("💾 Saving session cookies...");

  // Save storage state
  await context.storageState({ path: STORAGE_STATE_PATH });

  console.log(`✓ Session saved to: ${STORAGE_STATE_PATH}`);

  // Verify saved state has cookies
  const savedState = JSON.parse(
    await fs.readFile(STORAGE_STATE_PATH, "utf-8")
  );
  const cookieCount = savedState.cookies?.length || 0;

  console.log(`✓ Saved ${cookieCount} cookies`);

  await browser.close();

  console.log("");
  console.log("✅ Session renewal complete");
  console.log("");
  console.log("Next steps:");
  console.log("1. Verify scraper can use new session: npm run scrape");
  console.log("2. Check logs for successful authentication");
  console.log("");
}

renewSession().catch((err) => {
  console.error("❌ Session renewal failed:", err);
  process.exit(1);
});

