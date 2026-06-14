/* SPDX-License-Identifier: MIT */
/*
 * latency_reader.c — Userspace eBPF loader & histogram reader.
 *
 * Usage:  latency_reader <interface> <bpf_object_path>
 *
 * 1. Loads the compiled BPF object (latency_probe.o).
 * 2. Creates a clsact qdisc on <interface>.
 * 3. Attaches TC egress + ingress programs (shared maps).
 * 4. Waits for SIGTERM (sent by the worker when the benchmark finishes).
 * 5. Reads the latency histogram, computes percentiles.
 * 6. Prints a single-line JSON blob to stdout.
 * 7. Detaches programs and cleans up.
 */

#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <net/if.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>

#define MAX_HISTOGRAM_SLOTS  2048
#define HISTOGRAM_SLOT_NS    1000

static volatile sig_atomic_t running = 1;

static void sig_handler(int sig) {
    (void)sig;
    running = 0;
}

/* ------------------------------------------------------------------ */
/* Percentile computation from the histogram                          */
/* ------------------------------------------------------------------ */
static double percentile_us(const uint64_t *hist, int slots,
                            uint64_t total, double pct)
{
    uint64_t target = (uint64_t)((double)total * pct / 100.0);
    uint64_t cumulative = 0;
    for (int i = 0; i < slots; i++) {
        cumulative += hist[i];
        if (cumulative >= target)
            return (double)i * HISTOGRAM_SLOT_NS / 1000.0;  /* ns -> us */
    }
    return (double)(slots - 1) * HISTOGRAM_SLOT_NS / 1000.0;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */
int main(int argc, char *argv[])
{
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <interface> <bpf_obj_path>\n", argv[0]);
        return 1;
    }

    const char *iface    = argv[1];
    const char *obj_path = argv[2];

    int ifindex = (int)if_nametoindex(iface);
    if (!ifindex) {
        fprintf(stderr, "[eBPF] Interface %s not found\n", iface);
        return 1;
    }

    /* --- Suppress libbpf info-level logging ----------------------- */
    libbpf_set_print(NULL);

    /* --- Open & load BPF object ----------------------------------- */
    struct bpf_object *obj = bpf_object__open(obj_path);
    if (!obj) {
        fprintf(stderr, "[eBPF] Failed to open %s: %s\n",
                obj_path, strerror(errno));
        return 1;
    }

    /* Explicitly set program type to TC classifier (sched_cls).
     * Older libbpf versions don't auto-detect from SEC("tc/..."). */
    struct bpf_program *prog;
    bpf_object__for_each_program(prog, obj) {
        bpf_program__set_type(prog, BPF_PROG_TYPE_SCHED_CLS);
    }

    if (bpf_object__load(obj)) {
        fprintf(stderr, "[eBPF] Failed to load BPF object: %s\n",
                strerror(errno));
        bpf_object__close(obj);
        return 1;
    }

    /* --- Find programs -------------------------------------------- */
    struct bpf_program *prog_egress =
        bpf_object__find_program_by_name(obj, "tc_egress");
    struct bpf_program *prog_ingress =
        bpf_object__find_program_by_name(obj, "tc_ingress");

    if (!prog_egress || !prog_ingress) {
        fprintf(stderr, "[eBPF] Cannot find tc_egress / tc_ingress programs\n");
        bpf_object__close(obj);
        return 1;
    }

    int fd_egress  = bpf_program__fd(prog_egress);
    int fd_ingress = bpf_program__fd(prog_ingress);

    /* --- Create clsact qdisc ------------------------------------- */
    DECLARE_LIBBPF_OPTS(bpf_tc_hook, hook,
        .ifindex      = ifindex,
        .attach_point = BPF_TC_INGRESS | BPF_TC_EGRESS,
    );
    int err = bpf_tc_hook_create(&hook);
    /* -EEXIST is fine — qdisc may already exist */
    if (err && err != -EEXIST) {
        fprintf(stderr, "[eBPF] Failed to create clsact qdisc: %s\n",
                strerror(-err));
        bpf_object__close(obj);
        return 1;
    }

    /* --- Attach egress -------------------------------------------- */
    DECLARE_LIBBPF_OPTS(bpf_tc_opts, opts_egress,
        .prog_fd = fd_egress,
    );
    hook.attach_point = BPF_TC_EGRESS;
    err = bpf_tc_attach(&hook, &opts_egress);
    if (err) {
        fprintf(stderr, "[eBPF] Failed to attach egress: %s\n",
                strerror(-err));
        bpf_tc_hook_destroy(&hook);
        bpf_object__close(obj);
        return 1;
    }

    /* --- Attach ingress ------------------------------------------- */
    DECLARE_LIBBPF_OPTS(bpf_tc_opts, opts_ingress,
        .prog_fd = fd_ingress,
    );
    hook.attach_point = BPF_TC_INGRESS;
    err = bpf_tc_attach(&hook, &opts_ingress);
    if (err) {
        fprintf(stderr, "[eBPF] Failed to attach ingress: %s\n",
                strerror(-err));
        /* Detach egress before bailing out */
        hook.attach_point = BPF_TC_EGRESS;
        bpf_tc_detach(&hook, &opts_egress);
        bpf_tc_hook_destroy(&hook);
        bpf_object__close(obj);
        return 1;
    }

    fprintf(stderr, "[eBPF] Attached to %s (ifindex %d). Measuring...\n",
            iface, ifindex);

    /* --- Wait for SIGTERM ----------------------------------------- */
    signal(SIGTERM, sig_handler);
    signal(SIGINT,  sig_handler);

    while (running)
        sleep(1);

    /* --- Read debug counters --------------------------------------- */
    struct bpf_map *dbg_map = bpf_object__find_map_by_name(obj, "debug_counters");
    if (dbg_map) {
        int dbg_fd = bpf_map__fd(dbg_map);
        uint64_t c[16];
        memset(c, 0, sizeof(c));
        for (uint32_t i = 0; i < 16; i++)
            bpf_map_lookup_elem(dbg_fd, &i, &c[i]);

        fprintf(stderr, "[eBPF] === Debug Counters ===\n");
        fprintf(stderr, "[eBPF] Egress:  total=%llu  not_ip=%llu  not_tcp=%llu  short_pay=%llu  recorded=%llu\n",
                (unsigned long long)c[0], (unsigned long long)c[1],
                (unsigned long long)c[2], (unsigned long long)c[3],
                (unsigned long long)c[4]);
        fprintf(stderr, "[eBPF] Ingress: total=%llu  not_ip=%llu  not_tcp=%llu  short_pay=%llu  no_match=%llu  ok=%llu\n",
                (unsigned long long)c[5], (unsigned long long)c[6],
                (unsigned long long)c[7], (unsigned long long)c[8],
                (unsigned long long)c[9], (unsigned long long)c[10]);
        fprintf(stderr, "[eBPF] Proto: 0x%llx  IP@0=%llu  IP@Eth=%llu\n",
                (unsigned long long)c[11], (unsigned long long)c[12],
                (unsigned long long)c[13]);
    }

    /* --- Read histogram ------------------------------------------- */
    struct bpf_map *hist_map = bpf_object__find_map_by_name(obj, "latency_histogram");
    if (!hist_map) {
        fprintf(stderr, "[eBPF] Cannot find latency_histogram map\n");
        goto cleanup;
    }
    int hist_fd = bpf_map__fd(hist_map);

    uint64_t histogram[MAX_HISTOGRAM_SLOTS];
    memset(histogram, 0, sizeof(histogram));

    uint64_t total_samples = 0;
    for (uint32_t i = 0; i < MAX_HISTOGRAM_SLOTS; i++) {
        bpf_map_lookup_elem(hist_fd, &i, &histogram[i]);
        total_samples += histogram[i];
    }

    if (total_samples == 0) {
        /* No matched order/response pairs — output zeroes */
        printf("{\"samples\":0,\"p50_us\":0,\"p90_us\":0,\"p99_us\":0,"
               "\"min_us\":0,\"max_us\":0,\"mean_us\":0}\n");
        goto cleanup;
    }

    /* Compute percentiles */
    double p50 = percentile_us(histogram, MAX_HISTOGRAM_SLOTS, total_samples, 50.0);
    double p90 = percentile_us(histogram, MAX_HISTOGRAM_SLOTS, total_samples, 90.0);
    double p99 = percentile_us(histogram, MAX_HISTOGRAM_SLOTS, total_samples, 99.0);

    /* Compute min, max, mean */
    double min_us = 0, max_us = 0;
    uint64_t weighted_sum = 0;
    for (int i = 0; i < MAX_HISTOGRAM_SLOTS; i++) {
        if (histogram[i] > 0) {
            if (min_us == 0)
                min_us = (double)i * HISTOGRAM_SLOT_NS / 1000.0;
            max_us = (double)i * HISTOGRAM_SLOT_NS / 1000.0;
            weighted_sum += histogram[i] * (uint64_t)i;
        }
    }
    double mean_us = (double)weighted_sum * HISTOGRAM_SLOT_NS / 1000.0
                     / (double)total_samples;

    /* --- Output JSON to stdout ------------------------------------ */
    printf("{\"samples\":%llu,"
           "\"p50_us\":%.2f,\"p90_us\":%.2f,\"p99_us\":%.2f,"
           "\"min_us\":%.2f,\"max_us\":%.2f,\"mean_us\":%.2f}\n",
           (unsigned long long)total_samples,
           p50, p90, p99, min_us, max_us, mean_us);

    fprintf(stderr, "[eBPF] %llu samples. p50=%.1fus  p90=%.1fus  p99=%.1fus\n",
            (unsigned long long)total_samples, p50, p90, p99);

cleanup:
    /* --- Detach & destroy ----------------------------------------- */
    hook.attach_point = BPF_TC_EGRESS;
    bpf_tc_detach(&hook, &opts_egress);
    hook.attach_point = BPF_TC_INGRESS;
    bpf_tc_detach(&hook, &opts_ingress);
    hook.attach_point = BPF_TC_INGRESS | BPF_TC_EGRESS;
    bpf_tc_hook_destroy(&hook);
    bpf_object__close(obj);

    fprintf(stderr, "[eBPF] Detached and cleaned up.\n");
    return 0;
}
