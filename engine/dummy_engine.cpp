#include <iostream>
#include <list>
#include <map>
#include <unordered_map>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <unistd.h>
#include <cstring>
#include <algorithm>
#include "protocol.h"

// Internal order representation
struct Order {
    uint64_t cid;
    uint32_t qty;
    uint32_t price;
};

// O(1) cancel: map CID -> { price_level, side, iterator into list }
// Uses std::list (not deque) for iterator stability across insertions/deletions
struct OrderRef {
    bool is_bid;
    uint32_t price;
    std::list<Order>::iterator it;
};

// Price-Time Priority order book
// Bids: highest price first (descending). Asks: lowest price first (ascending).
std::map<uint32_t, std::list<Order>, std::greater<uint32_t>> bids;
std::map<uint32_t, std::list<Order>> asks;

// O(1) cancel index (Spec Section 3.1: "Cancel Orders (O(1) lookups)")
std::unordered_map<uint64_t, OrderRef> order_index;

void send_report(int sock, uint64_t cid, char status, uint32_t px, uint32_t rem) {
    ExecReport report;
    report.status = status;
    report.cid = cid;
    report.match_px = px;
    report.rem_qty = rem;
    send(sock, &report, sizeof(report), MSG_NOSIGNAL);
}

// Self-Matching Prevention (Spec Section 3.1):
// "Drop aggressive legs that cross the firm's own resting orders."
// Firm identity = upper 32 bits of CID (bot_id << 32 | seq)
inline uint32_t firm_id(uint64_t cid) {
    return (uint32_t)(cid >> 32);
}

void add_to_book(uint64_t cid, uint32_t qty, uint32_t price, bool is_bid) {
    Order order{cid, qty, price};
    if (is_bid) {
        auto& level = bids[price];
        level.push_back(order);
        order_index[cid] = {true, price, std::prev(level.end())};
    } else {
        auto& level = asks[price];
        level.push_back(order);
        order_index[cid] = {false, price, std::prev(level.end())};
    }
}

void remove_from_book(uint64_t cid) {
    auto idx_it = order_index.find(cid);
    if (idx_it == order_index.end()) return;
    auto& ref = idx_it->second;
    if (ref.is_bid) {
        auto level_it = bids.find(ref.price);
        if (level_it != bids.end()) {
            level_it->second.erase(ref.it);
            if (level_it->second.empty()) bids.erase(level_it);
        }
    } else {
        auto level_it = asks.find(ref.price);
        if (level_it != asks.end()) {
            level_it->second.erase(ref.it);
            if (level_it->second.empty()) asks.erase(level_it);
        }
    }
    order_index.erase(idx_it);
}

void match_order(int sock, NetworkOrder* req) {
    // --- Cancel Order: O(1) lookup ---
    if (req->op == 'C') {
        auto idx_it = order_index.find(req->cid);
        if (idx_it != order_index.end()) {
            send_report(sock, req->cid, 'X', 0, idx_it->second.it->qty);
            remove_from_book(req->cid);
        }
        return;
    }

    // --- Buy or Sell ---
    if (req->op != 'B' && req->op != 'S') return;
    
    bool is_buy = (req->op == 'B');
    uint32_t rem_qty = req->qty;
    uint32_t incoming_firm = firm_id(req->cid);

    if (is_buy) {
        // Match against asks (lowest first)
        auto it_level = asks.begin();
        while (rem_qty > 0 && it_level != asks.end() &&
               (req->price == 0 || it_level->first <= req->price)) {
            auto& level = it_level->second;
            auto it = level.begin();
            while (it != level.end() && rem_qty > 0) {
                // Self-matching prevention: drop the aggressive incoming order
                if (firm_id(it->cid) == incoming_firm) {
                    send_report(sock, req->cid, 'X', 0, rem_qty);
                    return;
                }

                uint32_t fill_qty = std::min(rem_qty, it->qty);
                rem_qty -= fill_qty;
                it->qty -= fill_qty;
                uint32_t match_price = it_level->first;

                // Report to aggressor (incoming buy)
                send_report(sock, req->cid, (rem_qty == 0 ? 'F' : 'P'), match_price, rem_qty);
                // Report to passive (resting sell)
                send_report(sock, it->cid, (it->qty == 0 ? 'F' : 'P'), match_price, it->qty);

                if (it->qty == 0) {
                    uint64_t filled_cid = it->cid;
                    it = level.erase(it);
                    order_index.erase(filled_cid);
                } else {
                    ++it;
                }
            }
            if (level.empty()) {
                it_level = asks.erase(it_level);
            } else {
                ++it_level;
            }
        }
        // Rest as limit order if unfilled and has a price
        if (rem_qty > 0 && req->price > 0) {
            add_to_book(req->cid, rem_qty, req->price, true);
        }
    } else {
        // Sell: match against bids (highest first)
        auto it_level = bids.begin();
        while (rem_qty > 0 && it_level != bids.end() &&
               (req->price == 0 || it_level->first >= req->price)) {
            auto& level = it_level->second;
            auto it = level.begin();
            while (it != level.end() && rem_qty > 0) {
                // Self-matching prevention
                if (firm_id(it->cid) == incoming_firm) {
                    send_report(sock, req->cid, 'X', 0, rem_qty);
                    return;
                }

                uint32_t fill_qty = std::min(rem_qty, it->qty);
                rem_qty -= fill_qty;
                it->qty -= fill_qty;
                uint32_t match_price = it_level->first;

                // Report to aggressor (incoming sell)
                send_report(sock, req->cid, (rem_qty == 0 ? 'F' : 'P'), match_price, rem_qty);
                // Report to passive (resting buy)
                send_report(sock, it->cid, (it->qty == 0 ? 'F' : 'P'), match_price, it->qty);

                if (it->qty == 0) {
                    uint64_t filled_cid = it->cid;
                    it = level.erase(it);
                    order_index.erase(filled_cid);
                } else {
                    ++it;
                }
            }
            if (level.empty()) {
                it_level = bids.erase(it_level);
            } else {
                ++it_level;
            }
        }
        // Rest as limit order if unfilled and has a price
        if (rem_qty > 0 && req->price > 0) {
            add_to_book(req->cid, rem_qty, req->price, false);
        }
    }
}

int main(int argc, char* argv[]) {
    int port = 8080;
    if (argc > 1) port = std::stoi(argv[1]);

    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = INADDR_ANY;

    bind(server_fd, (struct sockaddr*)&address, sizeof(address));
    listen(server_fd, 1024);
    std::cerr << "Engine listening on port " << port << std::endl;

    while (true) {
        int client_socket = accept(server_fd, nullptr, nullptr);
        if (client_socket < 0) continue;

        // TCP_NODELAY: disable Nagle for minimal latency on small writes
        int flag = 1;
        setsockopt(client_socket, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

        // Clear book state per connection
        bids.clear();
        asks.clear();
        order_index.clear();

        char* buffer = new char[1024 * 1024];
        int pos = 0;
        while (true) {
            ssize_t n = recv(client_socket, buffer + pos, (1024 * 1024) - pos, 0);
            if (n <= 0) break;
            pos += n;

            int offset = 0;
            while (offset + (int)sizeof(NetworkOrder) <= pos) {
                NetworkOrder req;
                memcpy(&req, buffer + offset, sizeof(NetworkOrder));
                match_order(client_socket, &req);
                offset += sizeof(NetworkOrder);
            }

            int rem = pos - offset;
            if (rem > 0 && offset > 0) memmove(buffer, buffer + offset, rem);
            pos = rem;
        }
        delete[] buffer;
        close(client_socket);
    }
    return 0;
}
