#!/bin/bash
# Builds macos/.build/WolfBud.app. Run that bundle, not `swift run`, so the mic
# prompt and the local-network exception in Info.plist apply.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
swift build -c release --product WolfBud
BIN_DIR="$(swift build -c release --show-bin-path)"
APP=".build/WolfBud.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN_DIR/WolfBud" "$APP/Contents/MacOS/WolfBud"
cp Info.plist "$APP/Contents/Info.plist"

MODEL="$ROOT/window/public/wolf-head.glb"
if [[ ! -f "$MODEL" ]]; then
  MODEL="$ROOT/mods/wolfbud/bridge/window/wolf-head.glb"
fi
cp "$MODEL" "$APP/Contents/Resources/wolf-head.glb"

ICON_SRC="$ROOT/assets/icon.png"
if [[ -f "$ICON_SRC" ]]; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi

# SPM links the binary frameworks that sit next to the product. Searching all
# of .build picks up an iOS or tvOS slice from the xcframework, which has no
# Versions/A and dyld then aborts at launch.
install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/WolfBud" || true
while read -r lib; do
  case "$lib" in
    @rpath/*.framework/*)
      name="$(printf '%s\n' "$lib" | sed -E 's#@rpath/([^/]+)\.framework/.*#\1#')"
      found="$BIN_DIR/${name}.framework"
      if [[ ! -d "$found" ]]; then
        echo "missing $found (the framework Swift linked)" >&2
        exit 1
      fi
      rm -rf "$APP/Contents/Frameworks/${name}.framework"
      cp -R "$found" "$APP/Contents/Frameworks/${name}.framework"
      codesign --force --sign - "$APP/Contents/Frameworks/${name}.framework"
      ;;
  esac
done < <(otool -L "$APP/Contents/MacOS/WolfBud" | awk 'NR>1 { print $1 }')

codesign --force --sign - "$APP"
echo "Built $APP"
