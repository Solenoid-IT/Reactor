#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# NDK Configuration
NDKDIR="${ANDROID_NDK_ROOT:-/Users/pierniccologiannelli/Library/Android/sdk/ndk/30.0.14904198}"
TOOLCHAIN="$NDKDIR/toolchains/llvm/prebuilt/darwin-x86_64"
TARGET="aarch64-linux-android21"
CC="$TOOLCHAIN/bin/aarch64-linux-android-clang"

if [ ! -f "$CC" ]; then
    echo "❌ Error: NDK toolchain not found at $NDKDIR"
    echo "   Set ANDROID_NDK_ROOT environment variable or update script"
    exit 1
fi

echo "🔨 Building QuickJS for arm64-v8a..."
echo "   Toolchain: $TOOLCHAIN"
echo "   Target: $TARGET"

# Clean previous build
make clean 2>/dev/null || true

# Compile
make \
    CC="$CC" \
    CFLAGS="-fPIC -O2 -std=c99 -D_GNU_SOURCE --target=$TARGET" \
    all

if [ -f "build/arm64-v8a/libquickjs.so" ]; then
    SIZE=$(stat -f%z "build/arm64-v8a/libquickjs.so" 2>/dev/null || stat -c%s "build/arm64-v8a/libquickjs.so")
    echo "✅ libquickjs.so built successfully ($(numfmt --to=iec-i --suffix=B "$SIZE" 2>/dev/null || echo "$SIZE bytes"))"
    
    # Copy to jniLibs
    JNIDIR="../app/src/main/jniLibs/arm64-v8a"
    mkdir -p "$JNIDIR"
    cp "build/arm64-v8a/libquickjs.so" "$JNIDIR/"
    echo "📦 Copied to $JNIDIR/libquickjs.so"
else
    echo "❌ Build failed"
    exit 1
fi
