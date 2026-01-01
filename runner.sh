#!/bin/sh
set -e

while true; do
  echo "[$(date)] boe-raw runner start"
  npm run scrape:cron || echo "[$(date)] boe-raw runner failed"
  echo "[$(date)] sleeping 300s"
  sleep 300
done

