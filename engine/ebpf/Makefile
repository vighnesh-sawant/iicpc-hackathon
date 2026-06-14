# eBPF Latency Probe — Build System
#
# Targets:
#   latency_probe.o  — BPF object (compiled with clang for the BPF target)
#   latency_reader   — Userspace loader/reader (compiled with gcc, linked against libbpf)

CLANG   ?= clang
GCC     ?= gcc
BPF_CFLAGS = -O2 -target bpf -g -D__TARGET_ARCH_x86 -I/usr/include/x86_64-linux-gnu
USER_CFLAGS = -O2 -Wall
USER_LDFLAGS = -lbpf -lelf -lz

all: latency_probe.o latency_reader

# BPF kernel program
latency_probe.o: latency_probe.bpf.c latency_probe.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

# Userspace loader / histogram reader
latency_reader: latency_reader.c latency_probe.h
	$(GCC) $(USER_CFLAGS) -o $@ $< $(USER_LDFLAGS)

clean:
	rm -f latency_probe.o latency_reader

.PHONY: all clean
