cmake_minimum_required(VERSION 3.18.1)
project(quickjs_jni)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_library(log-lib log)

# Compila QuickJS direttamente con CMake (invece di usare libquickjs.so precompilato)
# Questo evita problemi di rpath e dipendenze esterne su Android
add_library(quickjs STATIC
    ../../../../quickjs/src/quickjs.c
    ../../../../quickjs/src/quickjs-libc.c
    ../../../../quickjs/src/cutils.c
    ../../../../quickjs/src/libunicode.c
    ../../../../quickjs/src/libregexp.c
    ../../../../quickjs/src/libbf.c
)

target_include_directories(quickjs PRIVATE
    ../../../../quickjs/src
)

target_compile_options(quickjs PRIVATE
    -fPIC -O2 -std=c99 -D_GNU_SOURCE -DHAVE_REALLOC_BUFFER
)

# JNI wrapper
add_library(quickjs_jni SHARED quickjs_jni.cpp)

target_include_directories(quickjs_jni PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/../quickjs_headers"
)

target_link_libraries(quickjs_jni PRIVATE
    quickjs
    ${log-lib}
    m
)


