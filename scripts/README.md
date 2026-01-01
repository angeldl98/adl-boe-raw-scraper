# BOE Session Renewal

## When to Use

Run this script when:
- BOE scraper logs show authentication errors
- Session cookies have expired (typically every few weeks/months)
- You see "Unauthorized" or login redirect errors in scraper logs

## How to Run

### On VPS (with X11 forwarding)
```bash
# From your local machine, SSH with X11 forwarding
ssh -X user@your-vps

# Navigate to scraper directory
cd /opt/adl-suite/adl-boe-raw-scraper

# Run renewal script
npm run renew-session
```

### Alternative: Run Locally, Copy Cookies

If X11 forwarding is not available:
```bash
# On your local machine (with display)
git clone 
cd adl-boe-raw-scraper
npm install
npm run renew-session

# Copy the generated storageState.json to VPS
scp /path/to/local/storageState.json user@vps:/opt/adl-suite/data/boe_auth/storageState.json
```

## Important Notes

- This script is **manual only** - do NOT automate
- Session cookies are typically valid for weeks/months
- Backup of old session is created automatically
- Verify scraper works after renewal with: `npm run scrape`

## Troubleshooting

**Browser doesn't open:**
- Ensure X11 forwarding is enabled: `echo $DISPLAY`
- Or run locally and copy cookies to VPS

**Saved session doesn't work:**
- Check cookie count in output (should be > 0)
- Verify you logged in completely before pressing ENTER
- Try navigating to a protected page before saving

**Permission errors:**
- Ensure `/opt/adl-suite/data/boe_auth/` is writable
- Check file permissions on storageState.json

