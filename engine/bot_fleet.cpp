#include <iostream>
#include <thread>
#include <vector>
#include <atomic>
#include <chrono>
#include <cmath>
#include <random>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include "protocol.h"

// --- Global State ---
std::atomic<uint64_t> total_sent{0};
std::atomic<bool> running{true};
std::atomic<int> active_bots{0};

// Ornstein-Uhlenbeck parameters (Spec Section 8.2)
// dSt = θ(μ - St)dt + σdWt
const double OU_THETA = 5.0;    // Mean reversion speed
const double OU_MU    = 1000.0; // Long-term mean price
const double OU_SIGMA = 10.0;   // Volatility
const double OU_DT    = 0.0001; // Time step

std::atomic<double> current_mid_price{OU_MU};

// Fleet roles (Spec Section 8.3)
enum BotRole { MARKET_MAKER = 0, STAT_ARB = 1, NOISE_TRADER = 2, WHALE = 3 };

// --- OU Price Evolution Thread (Spec Section 8.2) ---
// All bots share this price via atomic. Deterministic via shared seed.
void ou_price_thread(uint64_t seed) {
    std::mt19937_64 gen(seed);
    std::normal_distribution<double> norm(0.0, 1.0);
    double S = OU_MU;

    while (running.load(std::memory_order_relaxed)) {
        double dW = norm(gen) * std::sqrt(OU_DT);
        S += OU_THETA * (OU_MU - S) * OU_DT + OU_SIGMA * dW;
        // Floor at 1 to prevent zero/negative prices
        if (S < 1.0) S = 1.0;
        current_mid_price.store(S, std::memory_order_relaxed);
        // ~10kHz price updates
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }
}

// --- Bot Worker ---
void bot_worker(int bot_id, BotRole role, const char* target_ip, int target_port) {
    active_bots.fetch_add(1, std::memory_order_relaxed);

    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        active_bots.fetch_sub(1, std::memory_order_relaxed);
        return;
    }

    sockaddr_in serv_addr{};
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(target_port);
    inet_pton(AF_INET, target_ip, &serv_addr.sin_addr);

    if (connect(sock, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
        close(sock);
        active_bots.fetch_sub(1, std::memory_order_relaxed);
        return;
    }

    // Deterministic PRNG per bot (Spec Section 8.2: shared-seed determinism)
    std::mt19937_64 gen(bot_id * 12345ULL + 42);
    std::uniform_int_distribution<int> side_dist(0, 1);
    std::uniform_int_distribution<int> cancel_pct(0, 99);
    std::uniform_int_distribution<int> spread_dist(1, 5);
    std::uniform_int_distribution<int> deep_otm_dist(50, 200);
    uint64_t seq = 0;

    // Drain buffer for non-blocking ExecReport reads
    char drain_buf[4096];

    // Ramp up: each bot waits an additional 500ms based on its ID
    std::this_thread::sleep_for(std::chrono::milliseconds(bot_id * 500));

    while (running.load(std::memory_order_relaxed)) {
        double mid = current_mid_price.load(std::memory_order_relaxed);
        NetworkOrder order{};
        order.cid = ((uint64_t)bot_id << 32) | (++seq);
        bool is_buy = side_dist(gen) == 0;

        switch (role) {
            case MARKET_MAKER: {
                // Spec: "Market Makers (60%): Maintain a 95% cancel ratio."
                if (seq > 1 && cancel_pct(gen) < 95) {
                    order.op = 'C';
                    // Cancel the previous order from this bot
                    order.cid = ((uint64_t)bot_id << 32) | (seq - 1);
                    order.price = 0;
                    order.qty = 0;
                } else {
                    order.op = is_buy ? 'B' : 'S';
                    int spr = spread_dist(gen);
                    order.price = (uint32_t)(is_buy ? std::max(1.0, mid - spr) : (mid + spr));
                    order.qty = 10;
                }
                break;
            }
            case STAT_ARB: {
                // Spec: "Stat-Arb Bots (15%): Fire IOC bursts to snap price back
                // to fair value when spreads widen."
                order.op = is_buy ? 'B' : 'S';
                order.price = 0;  // Market order = IOC behavior
                order.qty = 50;
                break;
            }
            case NOISE_TRADER: {
                // Spec: "Noise Traders (15%): Cause cache misses with deep OTM orders."
                order.op = is_buy ? 'B' : 'S';
                int offset = deep_otm_dist(gen);
                order.price = (uint32_t)(is_buy ? std::max(1.0, mid - offset) : (mid + offset));
                order.qty = 5;
                break;
            }
            case WHALE: {
                // Spec: "Whales (10%): Drop massive sweeps to trigger Stat-Arb reactions."
                order.op = is_buy ? 'B' : 'S';
                order.price = 0;  // Market sweep
                order.qty = 1000;
                break;
            }
        }

        if (send(sock, &order, sizeof(order), MSG_NOSIGNAL) <= 0) break;
        total_sent.fetch_add(1, std::memory_order_relaxed);

        // Non-blocking drain: consume ExecReports to prevent engine send buffer backpressure
        while (recv(sock, drain_buf, sizeof(drain_buf), MSG_DONTWAIT) > 0) {}
    }

    close(sock);
    active_bots.fetch_sub(1, std::memory_order_relaxed);
}

int main(int argc, char* argv[]) {
    signal(SIGPIPE, SIG_IGN);

    // CLI: bot_fleet [target_ip] [port] [seed] [num_bots]
    const char* target_ip = argc > 1 ? argv[1] : "127.0.0.1";
    int target_port       = argc > 2 ? std::stoi(argv[2]) : 8080;
    uint64_t seed         = argc > 3 ? std::stoull(argv[3]) : 42;
    int num_bots          = argc > 4 ? std::stoi(argv[4]) : 40;

    // Fleet composition (Spec Section 8.3)
    int mm_count = (int)(num_bots * 0.60);
    int sa_count = (int)(num_bots * 0.15);
    int nt_count = (int)(num_bots * 0.15);
    int wh_count = num_bots - mm_count - sa_count - nt_count;

    std::cout << "[Bot Fleet] " << num_bots << " bots -> "
              << mm_count << " MM, " << sa_count << " SA, "
              << nt_count << " NT, " << wh_count << " WH"
              << " | Target: " << target_ip << ":" << target_port
              << " | Seed: " << seed << std::endl;

    // Launch OU price evolution (Spec Section 8.2)
    std::thread ou_thread(ou_price_thread, seed);

    // Launch bot threads with role assignments
    std::vector<std::thread> bots;
    int id = 1;
    for (int i = 0; i < mm_count; i++)
        bots.emplace_back(bot_worker, id++, MARKET_MAKER, target_ip, target_port);
    for (int i = 0; i < sa_count; i++)
        bots.emplace_back(bot_worker, id++, STAT_ARB, target_ip, target_port);
    for (int i = 0; i < nt_count; i++)
        bots.emplace_back(bot_worker, id++, NOISE_TRADER, target_ip, target_port);
    for (int i = 0; i < wh_count; i++)
        bots.emplace_back(bot_worker, id++, WHALE, target_ip, target_port);

    // Stats reporting loop
    uint64_t last_total = 0;
    while (running.load()) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        uint64_t current_total = total_sent.load();
        uint64_t tps = current_total - last_total;
        last_total = current_total;
        double mid = current_mid_price.load();

        std::cout << "\r[Bot Fleet] TPS: " << tps
                  << " | Total: " << current_total
                  << " | Mid: " << (int)mid << "    " << std::flush;

        // Exit when all bots have disconnected (engine killed or send errors)
        if (active_bots.load() == 0 && current_total > 0) {
            std::cout << "\nAll bots disconnected." << std::endl;
            running.store(false);
        }
    }

    for (auto& b : bots) if (b.joinable()) b.join();
    running.store(false); // signal OU thread to stop
    if (ou_thread.joinable()) ou_thread.join();
    std::cout << "\nFinal total orders sent: " << total_sent.load() << std::endl;
    return 0;
}
