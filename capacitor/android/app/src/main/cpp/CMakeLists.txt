cmake_minimum_required(VERSION 3.18.1)
project(quickjs_jni)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_library(log-lib log)

# Pre-built QuickJS library
add_library(quickjs SHARED IMPORTED)
set_target_properties(quickjs PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/arm64-v8a/libquickjs.so"
)

# JNI wrapper
add_library(quickjs_jni SHARED quickjs_jni.cpp)

target_include_directories(quickjs_jni PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/../quickjs_headers"
)

target_link_libraries(quickjs_jni PRIVATE
    quickjs
    ${log-lib}
)
