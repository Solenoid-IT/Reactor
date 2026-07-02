# QuickJS for Android ARM64

QuickJS source code and build system for Android ARM64 (arm64-v8a) architecture.

## Structure

```
.
├── src/           # QuickJS source files (.c)
├── headers/       # QuickJS header files (.h)
├── build/         # Build output directory (generated)
├── Makefile       # Build configuration
├── build.sh       # Build automation script
└── README.md      # This file
```

## Building

### Quick Build
```bash
./build.sh
```

This will:
1. Compile QuickJS for ARM64 using NDK toolchain
2. Generate `build/arm64-v8a/libquickjs.so`
3. Copy to `../app/src/main/jniLibs/arm64-v8a/libquickjs.so`

### Manual Build
```bash
export CC="/path/to/android-ndk/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android-clang"
make clean
make all
```

## NDK Setup

The `build.sh` script expects the Android NDK at:
```
/Users/pierniccologiannelli/Library/Android/sdk/ndk/30.0.14904198
```

To use a different NDK path:
```bash
ANDROID_NDK_ROOT=/path/to/your/ndk ./build.sh
```

## Files Compiled

- `quickjs.c` - QuickJS core engine
- `quickjs-libc.c` - Standard library bindings (console, etc.)
- `cutils.c` - C utilities
- `libunicode.c` - Unicode support
- `libregexp.c` - Regular expression engine
- `libbf.c` - Big float support

## Integration with JNI

The built `libquickjs.so` is used by:
- `app/src/main/cpp/quickjs_jni.cpp` - C++ JNI wrapper
- `app/src/main/kotlin/com/reactor/app/QuickJsWrapper.kt` - Kotlin interface

## Troubleshooting

**Build fails with "toolchain not found":**
- Set `ANDROID_NDK_ROOT` environment variable
- Or update the NDK path in `build.sh`

**libquickjs.so not copied to jniLibs:**
- Check that `../app/src/main/jniLibs/arm64-v8a/` exists
- Run `./build.sh` with full paths if relative paths don't work

**Linker errors in APK build:**
- Verify `libquickjs.so` is in `app/src/main/jniLibs/arm64-v8a/`
- Check that `libquickjs.so` is ARM64 ELF: `file build/arm64-v8a/libquickjs.so`
