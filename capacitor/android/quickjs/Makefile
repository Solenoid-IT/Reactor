# QuickJS Android ARM64 Build
# Targets: arm64-v8a
# Note: CC must be set when calling make, e.g.:
# CC=/path/to/aarch64-linux-android21-clang make CFLAGS="..." all

BUILDDIR := build/arm64-v8a
OBJDIR := $(BUILDDIR)/obj
SRCDIR := src

# QuickJS source files (excluding test/demo programs)
SOURCES := \
	quickjs.c \
	quickjs-libc.c \
	cutils.c \
	libunicode.c \
	libregexp.c \
	libbf.c

OBJECTS := $(SOURCES:%.c=$(OBJDIR)/%.o)
TARGET := $(BUILDDIR)/libquickjs.so

# Default compiler flags (can be overridden)
CFLAGS ?= -fPIC -O2 -std=c99 -D_GNU_SOURCE -DHAVE_REALLOC_BUFFER

all: $(TARGET)

$(OBJDIR):
	mkdir -p $(OBJDIR)

$(OBJDIR)/%.o: $(SRCDIR)/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(TARGET): $(OBJECTS)
	mkdir -p $(BUILDDIR)
	$(CC) -shared $(OBJECTS) -lm -lc -o $@

clean:
	rm -rf $(BUILDDIR)

.PHONY: all clean
