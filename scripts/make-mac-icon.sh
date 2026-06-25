#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_JPG="$ROOT_DIR/assets/logo.jpg"
SOURCE_PNG="$ROOT_DIR/assets/logo.png"
ICONSET_DIR="$ROOT_DIR/assets/logo.iconset"
OUT_ICNS="$ROOT_DIR/assets/logo.icns"

if [[ -f "$SOURCE_PNG" ]]; then
  SOURCE_IMAGE="$SOURCE_PNG"
elif [[ -f "$SOURCE_JPG" ]]; then
  SOURCE_IMAGE="$SOURCE_JPG"
else
  echo "Error: missing source logo. Add assets/logo.png or assets/logo.jpg"
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SOURCE_IMAGE" -s format png --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  sips -z "$double_size" "$double_size" "$SOURCE_IMAGE" -s format png --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET_DIR" -o "$OUT_ICNS"
rm -rf "$ICONSET_DIR"

echo "Created $OUT_ICNS"
