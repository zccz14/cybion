#!/bin/sh
# Build the Cybion macOS viewer shell.
#
# Produces build/Cybion.app (universal by default), ad-hoc signed.
#   ARCHS="arm64"   build only Apple silicon
#   ARCHS="x86_64"  build only Intel
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
APP="$HERE/build/Cybion.app"
ARCHS=${ARCHS:-"arm64 x86_64"}
BUNDLE_ID=io.ntnl.cybion.app

echo "==> Cleaning"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> Compiling ($ARCHS)"
SLICES=""
for arch in $ARCHS; do
    out="$HERE/build/Cybion-$arch"
    xcrun -sdk macosx swiftc \
        -swift-version 5 \
        -O -whole-module-optimization \
        -target "$arch-apple-macos12.0" \
        -framework AppKit -framework WebKit \
        -o "$out" \
        "$HERE/Sources/main.swift"
    SLICES="$SLICES $out"
done

BIN="$HERE/build/Cybion"
if [ "$(echo $SLICES | wc -w)" -gt 1 ]; then
    xcrun lipo -create -output "$BIN" $SLICES
else
    cp $SLICES "$BIN"
fi
rm -f $SLICES

echo "==> Assembling bundle"
cp "$BIN" "$APP/Contents/MacOS/Cybion"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/Resources/Cybion.icns" "$APP/Contents/Resources/Cybion.icns"
cp "$ROOT/shell/ed25519-polyfill.js" "$APP/Contents/Resources/ed25519-polyfill.js"

echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$APP"

echo "==> Done: $APP"
xcrun lipo -archs "$APP/Contents/MacOS/Cybion" || true
