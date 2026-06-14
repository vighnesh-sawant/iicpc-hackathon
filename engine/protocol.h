#pragma once
#include <cstdint>

// Ingress Struct (17 Bytes) - Load Generator to Engine
// Spec Section 5: Network Protocol & Serialization
#pragma pack(push, 1)
struct NetworkOrder {
    char op;          // 1 byte: 'B' (Buy), 'S' (Sell), 'C' (Cancel)
    uint64_t cid;     // 8 bytes: Client Order ID
    uint32_t price;   // 4 bytes: Price (0 for Market Order)
    uint32_t qty;     // 4 bytes: Quantity
}; // 17 bytes

// Egress Struct (17 Bytes) - Engine to Load Generator
// Spec Section 5: Network Protocol & Serialization
struct ExecReport {
    char status;      // 1 byte: 'F' (Filled), 'P' (Partial), 'X' (Canceled)
    uint64_t cid;     // 8 bytes: Client Order ID
    uint32_t match_px; // 4 bytes: Executed Price (0 if canceled)
    uint32_t rem_qty;  // 4 bytes: Remaining Quantity
}; // 17 bytes
#pragma pack(pop)
