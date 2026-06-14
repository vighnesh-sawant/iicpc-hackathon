/* SPDX-License-Identifier: GPL-2.0 */
/*
 * latency_probe.bpf.c — eBPF TC programs for wire-to-wire latency measurement.
 *
 * Handles both L2 (Ethernet) and raw L3 veth layouts by probing for the
 * IPv4 version nibble at offset 0 and offset 14 (sizeof(ethhdr)).
 */

#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#include "latency_probe.h"

/* Debug counter indices */
#define DBG_EGR_TOTAL       0
#define DBG_EGR_NOT_IP      1
#define DBG_EGR_NOT_TCP     2
#define DBG_EGR_SHORT_PAY   3
#define DBG_EGR_RECORDED    4
#define DBG_ING_TOTAL       5
#define DBG_ING_NOT_IP      6
#define DBG_ING_NOT_TCP     7
#define DBG_ING_SHORT_PAY   8
#define DBG_ING_NO_MATCH    9
#define DBG_ING_LATENCY_OK  10
#define DBG_PROTO_VAL       11  /* stores skb->protocol raw value     */
#define DBG_IP_AT_0         12  /* IP header detected at offset 0     */
#define DBG_IP_AT_ETH       13  /* IP header detected after ethhdr    */
#define DBG_MAX             16

/* ------------------------------------------------------------------ */
/* BPF Maps                                                           */
/* ------------------------------------------------------------------ */

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1048576);
    __type(key,   __u64);
    __type(value, __u64);
} send_timestamps SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, MAX_HISTOGRAM_SLOTS);
    __type(key,   __u32);
    __type(value, __u64);
} latency_histogram SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, DBG_MAX);
    __type(key,   __u32);
    __type(value, __u64);
} debug_counters SEC(".maps");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

static __always_inline void dbg_inc(__u32 idx)
{
    __u64 *val = bpf_map_lookup_elem(&debug_counters, &idx);
    if (val)
        __sync_fetch_and_add(val, 1);
}

static __always_inline void dbg_set(__u32 idx, __u64 v)
{
    __u64 *val = bpf_map_lookup_elem(&debug_counters, &idx);
    if (val)
        *val = v;
}

/*
 * Detect the IP header offset by inspecting the IPv4 version nibble.
 * Works regardless of whether the kernel pushes an L2 header or not.
 *
 * Returns: byte offset from data to IP header, or -1 if not IPv4.
 */
static __always_inline int
get_ip_offset(struct __sk_buff *skb, void *data, void *data_end)
{
    /* Store skb->protocol for debugging (first packet only) */
    dbg_set(DBG_PROTO_VAL, (__u64)skb->protocol);

    /* Try 1: data starts directly at IP header (no L2) */
    if (data + 1 <= data_end) {
        __u8 first;
        __builtin_memcpy(&first, data, 1);
        dbg_set(DBG_IP_AT_0, (__u64)first); /* DUMP FIRST BYTE */
        if ((first >> 4) == 4) {  /* IPv4 version nibble = 4 */
            return 0;
        }
    }

    /* Try 2: data starts at Ethernet header (14 bytes) */
    if (data + sizeof(struct ethhdr) + 1 <= data_end) {
        __u8 first;
        void *maybe_ip = data + sizeof(struct ethhdr);
        __builtin_memcpy(&first, maybe_ip, 1);
        dbg_set(DBG_IP_AT_ETH, (__u64)first); /* DUMP FIRST BYTE OF L3 */
        if ((first >> 4) == 4) {
            return (int)sizeof(struct ethhdr);
        }
    }

    return -1;
}

/* ------------------------------------------------------------------ */
/* TC Egress — bot fleet → engine  (NetworkOrder, 17 bytes)            */
/* ------------------------------------------------------------------ */
SEC("tc/egress")
int tc_egress(struct __sk_buff *skb)
{
    void *data     = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    dbg_inc(DBG_EGR_TOTAL);

    int ip_off = get_ip_offset(skb, data, data_end);
    if (ip_off < 0) {
        dbg_inc(DBG_EGR_NOT_IP);
        return TC_ACT_OK;
    }

    struct iphdr *ip = (void *)((char *)data + ip_off);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;
    if (ip->protocol != IPPROTO_TCP) {
        dbg_inc(DBG_EGR_NOT_TCP);
        return TC_ACT_OK;
    }

    __u32 ip_hdr_len = ip->ihl * 4;
    if (ip_hdr_len < sizeof(struct iphdr))
        return TC_ACT_OK;

    struct tcphdr *tcp = (void *)((char *)ip + ip_hdr_len);
    if ((void *)(tcp + 1) > data_end)
        return TC_ACT_OK;

    __u32 tcp_hdr_len = tcp->doff * 4;
    if (tcp_hdr_len < sizeof(struct tcphdr))
        return TC_ACT_OK;

    __u32 ip_total = bpf_ntohs(ip->tot_len);
    if (ip_total < ip_hdr_len + tcp_hdr_len)
        return TC_ACT_OK;

    __u32 pay_len = ip_total - ip_hdr_len - tcp_hdr_len;

    if (pay_len < 17) {
        dbg_inc(DBG_EGR_SHORT_PAY);
        return TC_ACT_OK;
    }

    /* Extract order_id — starts at offset 1 of TCP payload. */
    __u32 payload_off = ip_off + ip_hdr_len + tcp_hdr_len;
    if (bpf_skb_pull_data(skb, payload_off + 9) < 0)
        return TC_ACT_OK;

    /* Reload pointers after pull */
    data = (void *)(long)skb->data;
    data_end = (void *)(long)skb->data_end;
    void *payload = data + payload_off;

    if (payload + 9 > data_end)
        return TC_ACT_OK;

    __u64 order_id;
    __builtin_memcpy(&order_id, payload + 1, sizeof(order_id));

    __u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&send_timestamps, &order_id, &ts, BPF_ANY);
    dbg_inc(DBG_EGR_RECORDED);

    return TC_ACT_OK;
}

/* ------------------------------------------------------------------ */
/* TC Ingress — engine → bot fleet  (ExecReport, 17 bytes)            */
/* ------------------------------------------------------------------ */
SEC("tc/ingress")
int tc_ingress(struct __sk_buff *skb)
{
    void *data     = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    dbg_inc(DBG_ING_TOTAL);

    int ip_off = get_ip_offset(skb, data, data_end);
    if (ip_off < 0) {
        dbg_inc(DBG_ING_NOT_IP);
        return TC_ACT_OK;
    }

    struct iphdr *ip = (void *)((char *)data + ip_off);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;
    if (ip->protocol != IPPROTO_TCP) {
        dbg_inc(DBG_ING_NOT_TCP);
        return TC_ACT_OK;
    }

    __u32 ip_hdr_len = ip->ihl * 4;
    if (ip_hdr_len < sizeof(struct iphdr))
        return TC_ACT_OK;

    struct tcphdr *tcp = (void *)((char *)ip + ip_hdr_len);
    if ((void *)(tcp + 1) > data_end)
        return TC_ACT_OK;

    __u32 tcp_hdr_len = tcp->doff * 4;
    if (tcp_hdr_len < sizeof(struct tcphdr))
        return TC_ACT_OK;

    __u32 ip_total = bpf_ntohs(ip->tot_len);
    if (ip_total < ip_hdr_len + tcp_hdr_len)
        return TC_ACT_OK;

    __u32 pay_len = ip_total - ip_hdr_len - tcp_hdr_len;

    if (pay_len < 17) {
        dbg_inc(DBG_ING_SHORT_PAY);
        return TC_ACT_OK;
    }

    __u32 payload_off = ip_off + ip_hdr_len + tcp_hdr_len;
    if (bpf_skb_pull_data(skb, payload_off + 9) < 0)
        return TC_ACT_OK;

    data = (void *)(long)skb->data;
    data_end = (void *)(long)skb->data_end;
    void *payload = data + payload_off;

    if (payload + 9 > data_end)
        return TC_ACT_OK;

    __u64 order_id;
    __builtin_memcpy(&order_id, payload + 1, sizeof(order_id));

    __u64 now = bpf_ktime_get_ns();

    __u64 *send_ts = bpf_map_lookup_elem(&send_timestamps, &order_id);
    if (!send_ts) {
        dbg_inc(DBG_ING_NO_MATCH);
        return TC_ACT_OK;
    }

    __u64 latency_ns = now - *send_ts;
    bpf_map_delete_elem(&send_timestamps, &order_id);

    __u32 slot = (__u32)(latency_ns / HISTOGRAM_SLOT_NS);
    if (slot >= MAX_HISTOGRAM_SLOTS)
        slot = MAX_HISTOGRAM_SLOTS - 1;

    __u64 *count = bpf_map_lookup_elem(&latency_histogram, &slot);
    if (count)
        __sync_fetch_and_add(count, 1);

    dbg_inc(DBG_ING_LATENCY_OK);
    return TC_ACT_OK;
}

char _license[] SEC("license") = "GPL";
