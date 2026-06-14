#ifndef LATENCY_PROBE_H
#define LATENCY_PROBE_H

/*
 * Shared definitions between BPF kernel program and userspace reader.
 *
 * Histogram: 2048 slots of 1 microsecond each.
 *   - Slot 0: latencies in [0, 1) µs
 *   - Slot 1: latencies in [1, 2) µs
 *   - ...
 *   - Slot 2047: latencies >= 2047 µs (overflow bucket)
 *
 * This covers 0 – 2.047 ms with 1 µs resolution, which is ideal for
 * HFT-grade latency benchmarking over a veth pair.
 */

#define MAX_HISTOGRAM_SLOTS  2048
#define HISTOGRAM_SLOT_NS    1000   /* 1 microsecond per slot */

#endif /* LATENCY_PROBE_H */
