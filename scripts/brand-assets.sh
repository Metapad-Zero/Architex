#!/usr/bin/env bash
# Regenerates every raster brand asset in public/ from the sources in brand/.
#
#   bash scripts/brand-assets.sh
#
# Icons are pure shapes, rendered by rsvg-convert (brew install librsvg). The link-preview card has
# text, so it is rendered by headless Chrome with the real Public Sans from node_modules.
# When the card changes, bump OG_NAME here and in index.html: social sites cache cards by URL.
set -euo pipefail
cd "$(dirname "$0")/.."

OG_NAME="og-2.png"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

cp brand/icon.svg public/icon.svg
for size in 32 180 192 512; do
  rsvg-convert -w "$size" -h "$size" brand/icon.svg -o "public/icon-$size.png"
done
mv public/icon-180.png public/apple-touch-icon.png
rsvg-convert -w 512 -h 512 brand/icon-maskable.svg -o public/icon-maskable-512.png

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=4000 --allow-file-access-from-files \
  --screenshot="$PWD/public/$OG_NAME" "file://$PWD/brand/og.html" >/dev/null 2>&1

ls -l public/
