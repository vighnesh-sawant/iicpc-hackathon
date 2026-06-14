const net = require('net');

const PORT = parseInt(process.argv[2] || '8080', 10);
const HOST = process.argv[3] || '127.0.0.1';

// Struct sizes: NetworkOrder=17, ExecReport=17
function makeOrder(op, firmId, seqId, price, qty) {
    const buf = Buffer.alloc(17);
    buf.writeUInt8(op.charCodeAt(0), 0);
    const cid = (BigInt(firmId) << 32n) | BigInt(seqId);
    buf.writeBigUInt64LE(cid, 1);
    buf.writeUInt32LE(price, 9);
    buf.writeUInt32LE(qty, 13);
    return buf;
}

function parseReport(buf) {
    const reports = [];
    for (let i = 0; i < buf.length; i += 17) {
        if (i + 17 > buf.length) break;
        reports.push({
            status: String.fromCharCode(buf.readUInt8(i)),
            cid: buf.readBigUInt64LE(i + 1),
            match_px: buf.readUInt32LE(i + 9),
            rem_qty: buf.readUInt32LE(i + 13)
        });
    }
    return reports;
}

const testResults = [];

async function runTest(name, testFn) {
    console.log(`[Test] ${name}`);
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let reports = [];
        let done = false;

        const finish = (err) => {
            if (done) return;
            done = true;
            client.destroy();
            if (err) {
                testResults.push({ name, passed: false, error: err.message });
                reject(err);
            } else {
                testResults.push({ name, passed: true });
                resolve();
            }
        };

        client.connect(PORT, HOST, () => {
            try {
                testFn(client, (expectedCount, callback) => {
                    // Wait for expectedCount reports
                    const check = () => {
                        if (reports.length >= expectedCount) {
                            try {
                                callback(reports.slice(0, expectedCount));
                                reports = reports.slice(expectedCount);
                            } catch (e) {
                                return finish(e);
                            }
                        } else {
                            setTimeout(check, 10);
                        }
                    };
                    check();
                }, finish);
            } catch (e) {
                finish(e);
            }
        });

        client.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            const newReports = parseReport(buffer);
            const consumed = newReports.length * 17;
            buffer = buffer.subarray(consumed);
            reports.push(...newReports);
        });

        client.on('error', finish);
        setTimeout(() => finish(new Error("Timeout")), 2000);
    });
}

async function main() {
    try {
        await runTest("1. Exact Match", (client, expect, done) => {
            client.write(makeOrder('B', 1, 1, 100, 10));
            client.write(makeOrder('S', 2, 1, 100, 10));
            expect(2, (reps) => {
                if (reps[0].status !== 'F' || reps[1].status !== 'F') throw new Error("Expected F");
                if (reps[0].rem_qty !== 0 || reps[1].rem_qty !== 0) throw new Error("Expected rem 0");
                done();
            });
        });

        await runTest("2. Partial Fill", (client, expect, done) => {
            client.write(makeOrder('B', 1, 2, 100, 10));
            client.write(makeOrder('S', 2, 2, 100, 5));
            expect(2, (reps) => {

                // Our engine reports: first to aggressor, then passive.
                // Aggressor: Sell 5. Rem=0 => F.
                // Passive: Buy 10. Rem=5 => P.
                const agg = reps[0];
                const pas = reps[1];
                if (agg.status !== 'F' || agg.rem_qty !== 0) throw new Error("Aggressor should be F");
                if (pas.status !== 'P' || pas.rem_qty !== 5) throw new Error("Passive should be P");
                done();
            });
        });

        await runTest("3. Price-Time Priority", (client, expect, done) => {
            client.write(makeOrder('B', 1, 3, 100, 10));
            setTimeout(() => {
                client.write(makeOrder('B', 2, 3, 100, 10));
                setTimeout(() => {
                    client.write(makeOrder('S', 3, 3, 100, 15));
                    // Expect 4 reports:
                    // 1. Aggressor(15) matching first order(10) -> P, rem 5
                    // 2. Passive(10) matched fully -> F, rem 0
                    // 3. Aggressor(5) matching second order(10) -> F, rem 0
                    // 4. Passive(10) matched 5 -> P, rem 5
                    expect(4, (reps) => {
                        if (reps[0].status !== 'P' || reps[0].rem_qty !== 5) throw new Error("Err 1");
                        if (reps[1].status !== 'F' || reps[1].rem_qty !== 0) throw new Error("Err 2");
                        if (reps[2].status !== 'F' || reps[2].rem_qty !== 0) throw new Error("Err 3");
                        if (reps[3].status !== 'P' || reps[3].rem_qty !== 5) throw new Error("Err 4");
                        done();
                    });
                }, 50);
            }, 50);
        });

        await runTest("4. Cancel Order", (client, expect, done) => {
            client.write(makeOrder('B', 1, 4, 50, 10));
            setTimeout(() => {
                client.write(makeOrder('C', 1, 4, 0, 0));
                expect(1, (reps) => {
                    if (reps[0].status !== 'X' || reps[0].rem_qty !== 10) throw new Error("Expected X rem 10");
                    done();
                });
            }, 50);
        });

        await runTest("5. Cancel Non-existent", (client, expect, done) => {
            client.write(makeOrder('C', 9, 9, 0, 0));
            // Should ignore. Send a valid order after to verify it's still alive.
            client.write(makeOrder('B', 1, 5, 100, 10));
            client.write(makeOrder('S', 2, 5, 100, 10));
            expect(2, (reps) => done());
        });

        await runTest("6. Self-Matching Prevention", (client, expect, done) => {
            client.write(makeOrder('B', 5, 1, 100, 10));
            setTimeout(() => {
                client.write(makeOrder('S', 5, 2, 100, 10)); // Same firm 5
                expect(1, (reps) => {
                    if (reps[0].status !== 'X' || reps[0].rem_qty !== 10) throw new Error("Expected X due to self-match");
                    done();
                });
            }, 50);
        });

        await runTest("7. Invalid Op Fuzzing", (client, expect, done) => {
            client.write(makeOrder('Z', 1, 1, 100, 10));
            // Send valid order after
            client.write(makeOrder('B', 1, 6, 100, 10));
            client.write(makeOrder('S', 2, 6, 100, 10));
            expect(2, (reps) => done());
        });

        await runTest("8. Market Order Fuzzing (No Match)", (client, expect, done) => {
            client.write(makeOrder('S', 1, 7, 0, 10)); // Sell market
            // Engine should drop it silently if no bids
            client.write(makeOrder('B', 1, 8, 100, 10));
            client.write(makeOrder('S', 2, 8, 100, 10));
            expect(2, (reps) => done());
        });

        await runTest("9. Fragmented Packet", (client, expect, done) => {
            const buf1 = makeOrder('B', 1, 9, 100, 10);
            const buf2 = makeOrder('S', 2, 9, 100, 10);
            
            // Fragment the buy order
            client.write(buf1.subarray(0, 5));
            setTimeout(() => {
                client.write(buf1.subarray(5));
                client.write(buf2);
                expect(2, (reps) => done());
            }, 50);
        });

        await runTest("10. Multiple Orders Batched", (client, expect, done) => {
            const b1 = makeOrder('B', 1, 10, 100, 10);
            const b2 = makeOrder('S', 2, 10, 100, 10);
            client.write(Buffer.concat([b1, b2]));
            expect(2, (reps) => {
                if (reps[0].status !== 'F' || reps[1].status !== 'F') throw new Error("Failed batched");
                done();
            });
        });

        console.log("All 10 Correctness tests passed!");
        // Output structured results as JSON on a special line for the worker to parse
        console.log(`__CORRECTNESS_RESULTS__${JSON.stringify(testResults)}`);
        process.exit(0);
    } catch (e) {
        console.error("Correctness check failed:", e);
        // Still output partial results so worker knows which tests passed
        console.log(`__CORRECTNESS_RESULTS__${JSON.stringify(testResults)}`);
        process.exit(1);
    }
}

main();
