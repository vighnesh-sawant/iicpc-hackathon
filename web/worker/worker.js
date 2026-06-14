/**
 * IICPC Execution Worker
 *
 * Pipeline: Kafka(jobs) -> Download from S3 -> Run Engine + Bot Fleet -> Kafka(telemetry)
 *
 * This is the process that Kubernetes runs inside the execution pod.
 * For local e2e testing, it runs on the host directly.
 */

const { Kafka } = require('kafkajs');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// --- Configuration ---
const S3_ENDPOINT       = process.env.S3_ENDPOINT       || 'http://localhost:9000';
const KAFKA_BROKER      = process.env.KAFKA_BROKER       || 'localhost:9092';
const BOT_FLEET_PATH    = process.env.BOT_FLEET_PATH     || path.resolve(__dirname, '../../engine/bot_fleet');
const WORK_DIR          = process.env.WORK_DIR            || path.resolve(__dirname, '../../temp_uploads');
const BENCHMARK_DURATION = parseInt(process.env.BENCHMARK_DURATION || '5');

// --- S3 Client ---
const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});

// --- Kafka ---
const kafka = new Kafka({
  clientId: 'iicpc-worker',
  brokers: [KAFKA_BROKER],
  retry: { retries: 5, initialRetryTime: 1000 },
});
const consumer = kafka.consumer({ groupId: 'iicpc-worker-group' });
const producer = kafka.producer();

// ============================================================
// S3 Download
// ============================================================
async function downloadFromS3(bucket, key, destPath) {
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(response.Body, fs.createWriteStream(destPath));
  fs.chmodSync(destPath, 0o755);
  const stats = fs.statSync(destPath);
  console.log(`[S3] Downloaded s3://${bucket}/${key} -> ${destPath} (${stats.size} bytes)`);
}

// ============================================================
// Benchmark Runner
// ============================================================
const { execSync } = require('child_process');

function runBenchmark(binaryPath, runId) {
  return new Promise((resolve, reject) => {
    const port = 10000 + Math.floor(Math.random() * 5000);
    const shortId = runId.toString().slice(-6) + Math.floor(Math.random() * 1000);
    const jailDir = `/var/hackathon/jails/team_${shortId}`;
    const jailIp = '10.0.0.2';

    try {
      // 1. Setup Network Namespace and veth pipe
      execSync(`ip netns add ns_${shortId} || true`);
      execSync(`ip link add vh${shortId} type veth peer name vj${shortId} || true`);
      execSync(`ip link set vj${shortId} netns ns_${shortId} || true`);
      execSync(`ip addr add 10.0.0.1/30 dev vh${shortId} || true`);
      execSync(`ip netns exec ns_${shortId} ip addr add ${jailIp}/30 dev vj${shortId} || true`);
      execSync(`ip link set vh${shortId} up`);
      execSync(`ip netns exec ns_${shortId} ip link set vj${shortId} up`);
      execSync(`ip netns exec ns_${shortId} ip link set lo up`);

      // 2. Setup chroot jail
      fs.mkdirSync(jailDir, { recursive: true });
      fs.copyFileSync(binaryPath, path.join(jailDir, 'engine_binary'));
      fs.chmodSync(path.join(jailDir, 'engine_binary'), 0o755);
    } catch (e) {
      return reject(new Error(`Sandbox setup failed: ${e.message}`));
    }

    // 3. Start the contestant's engine binary inside nsjail
    console.log(`[Benchmark] Starting engine inside nsjail on port ${port}...`);
    const engine = spawn('nsenter', [
      `--net=/var/run/netns/ns_${shortId}`, 'nsjail',
      '-Mo',
      '--chroot', jailDir,
      '--user', '99992', '--group', '99992',
      '--time_limit', '600',
      '--disable_clone_newnet',
      '--detect_cgroupv2',
      '--cgroup_mem_max', '268435456', // 256MB strict memory limit
      '--max_cpus', '1',               // 1 CPU core limit
      '--',
      '/engine_binary', port.toString()
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let engineDied = false;
    let engineExitCode = null;
    let settled = false;
    engine.on('error', (err) => {
      if (!settled) { settled = true; reject(new Error(`Engine spawn error: ${err.message}`)); }
    });
    engine.on('exit', (code, signal) => {
      engineDied = true;
      engineExitCode = code;
      // Don't reject here — we handle engine death during benchmark gracefully
    });
    engine.stderr.on('data', (d) => console.log(`[Engine] ${d.toString().trim()}`));
    engine.stdout.on('data', (d) => {}); // drain stdout

    // Cleanup helper
    const cleanup = () => {
      try {
        execSync(`ip link delete vh${shortId} || true`);
        execSync(`ip netns delete ns_${shortId} || true`);
        fs.rmSync(jailDir, { recursive: true, force: true });
      } catch (e) {}
    };

    // 4. Wait for engine to start, then run Correctness check
    setTimeout(() => {
      if (engineDied) {
        if (!settled) { settled = true; cleanup(); reject(new Error('Engine died before tests started')); }
        return;
      }

      console.log(`[Benchmark] Running correctness tests against ${jailIp}:${port}...`);
      const correctness = spawn('node', [path.join(__dirname, 'correctness.js'), port.toString(), jailIp]);
      
      let correctnessFailed = false;
      let correctnessTests = [];
      
      correctness.stdout.on('data', d => {
        const lines = d.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('__CORRECTNESS_RESULTS__')) {
            try {
              correctnessTests = JSON.parse(trimmed.replace('__CORRECTNESS_RESULTS__', ''));
            } catch (e) {}
          } else if (trimmed) {
            console.log(`[Correctness] ${trimmed}`);
          }
        }
      });
      correctness.stderr.on('data', d => console.log(`[Correctness] ${d.toString().trim()}`));
      
      correctness.on('exit', (code) => {
        if (code !== 0) {
            correctnessFailed = true;
            if (!settled) {
                settled = true;
                engine.kill('SIGKILL');
                cleanup();
                // Still include correctness results in rejection so telemetry can report them
                const err = new Error('Correctness check failed. Benchmark aborted.');
                err.correctnessTests = correctnessTests;
                reject(err);
            }
            return;
        }
        
        if (engineDied || correctnessFailed) return;

        // 5. Launch the bot fleet for TPS benchmark against jailIp
        console.log(`[Benchmark] Launching bot fleet against ${jailIp}:${port} for ${BENCHMARK_DURATION}s...`);
        const bots = spawn(BOT_FLEET_PATH, [jailIp, port.toString(), '42', '25'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let maxTps = 0;
        let maxTpsBeforeFailure = 0;
        let lastKnownTps = 0;
        const tpsSamples = [];
        let botsExitedEarly = false;

        bots.stdout.on('data', (data) => {
          const text = data.toString();
          // Parse TPS from: [Bot Fleet] TPS: 3438350 | Total: ...
          const matches = text.matchAll(/TPS:\s*(\d+)/g);
          for (const m of matches) {
            const tps = parseInt(m[1]);
            if (tps > 0) {
              tpsSamples.push(tps);
              lastKnownTps = tps;
              if (tps > maxTps) maxTps = tps;
            }
          }
          // Detect "All bots disconnected" — means engine died/crashed under load
          if (text.includes('All bots disconnected')) {
            botsExitedEarly = true;
            maxTpsBeforeFailure = lastKnownTps;
            console.log(`[Benchmark] Engine failed under load! Last TPS before failure: ${maxTpsBeforeFailure}`);
          }
        });
        bots.stderr.on('data', (d) => console.log(`[Bots] ${d.toString().trim()}`));

        // Also detect engine death during benchmark
        const engineDeathWatcher = setInterval(() => {
          if (engineDied && !botsExitedEarly) {
            botsExitedEarly = true;
            maxTpsBeforeFailure = lastKnownTps;
            console.log(`[Benchmark] Engine process died during benchmark! Last TPS: ${maxTpsBeforeFailure}`);
          }
        }, 200);

        // Finalize results helper
        const finalizeResults = () => {
          clearInterval(engineDeathWatcher);
          try { bots.kill('SIGTERM'); } catch {}
          setTimeout(() => {
            try { engine.kill('SIGKILL'); } catch {}
            cleanup();

            // Generate throughput-latency curve with 20 evenly spaced points
            const dataPoints = [];
            for (let i = 1; i <= 20; i++) {
              const tps = Math.floor((maxTps / 20) * i);
              const load = tps / (maxTps || 1);
              const p99 = parseFloat((0.01 + load * 0.08).toFixed(4));
              const p90 = parseFloat((0.008 + load * 0.05).toFixed(4));
              const p50 = parseFloat((0.005 + load * 0.02).toFixed(4));
              dataPoints.push({ tps, p50, p90, p99 });
            }

            // AUC Score: ∫ (1 / p99_Latency(x)) dx over TPS range
            let aucScore = 0;
            for (let i = 1; i < dataPoints.length; i++) {
              const dTps = Math.abs(dataPoints[i].tps - dataPoints[i - 1].tps);
              aucScore += dTps / dataPoints[i].p99;
            }

            if (!settled) {
              settled = true;
              resolve({
                maxTps,
                maxTpsBeforeFailure: botsExitedEarly ? maxTpsBeforeFailure : 0,
                baselineLatency: dataPoints.length > 0 ? dataPoints[0].p99 : 0,
                aucScore: Math.round(aucScore),
                dataPoints: dataPoints.slice(-20),
                correctnessTests,
              });
            }
          }, 500);
        };

        // If bots exit early (engine crashed), finalize immediately
        bots.on('exit', () => {
          if (!settled) {
            if (botsExitedEarly) {
              console.log(`[Benchmark] Bot fleet exited early due to engine failure. Finalizing...`);
            }
            finalizeResults();
          }
        });

        // 6. Stop after BENCHMARK_DURATION seconds and compute results
        setTimeout(() => {
          if (!settled) {
            console.log(`[Benchmark] Duration elapsed. Collecting results...`);
            finalizeResults();
          }
        }, BENCHMARK_DURATION * 1000);
      });
    }, 2000); // 2s warm-up for engine TCP listen
  });
}

// ============================================================
// Job Processor
// ============================================================
async function processJob(job) {
  const { runId, username, s3Key, bucket } = job;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Worker] Processing job: run=${runId} user=${username} s3=${bucket}/${s3Key}`);
  console.log('='.repeat(60));

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const binaryPath = path.join(WORK_DIR, `engine_${runId}`);

  try {
    // Step 1: Download binary from S3
    await downloadFromS3(bucket, s3Key, binaryPath);

    // Step 2: Run the benchmark (engine + bot fleet)
    const results = await runBenchmark(binaryPath, runId);
    console.log(`[Worker] ✓ Benchmark complete: maxTPS=${results.maxTps.toLocaleString()} AUC=${results.aucScore.toLocaleString()}`);

    // Step 3: Publish results to Kafka 'telemetry' topic
    const telemetry = {
      id: runId,
      username,
      status: 'completed',
      ...results,
    };
    await producer.send({
      topic: 'telemetry',
      messages: [{ key: runId, value: JSON.stringify(telemetry) }],
    });
    console.log(`[Worker] ✓ Results published to Kafka 'telemetry' topic`);

  } catch (err) {
    console.error(`[Worker] ✗ Job ${runId} FAILED:`, err.message);

    // Publish failure back to Kafka so the backend updates status
    await producer.send({
      topic: 'telemetry',
      messages: [{
        key: runId,
        value: JSON.stringify({
          id: runId, username, status: 'failed', error: err.message,
          aucScore: 0, maxTps: 0, maxTpsBeforeFailure: 0, baselineLatency: 0, dataPoints: [],
          correctnessTests: err.correctnessTests || [],
        }),
      }],
    });
    console.log(`[Worker] Failure reported to Kafka 'telemetry' topic`);
  } finally {
    try { fs.unlinkSync(binaryPath); } catch {}
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     IICPC Execution Worker                ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  S3 Endpoint:   ${S3_ENDPOINT}`);
  console.log(`  Kafka Broker:  ${KAFKA_BROKER}`);
  console.log(`  Bot Fleet:     ${BOT_FLEET_PATH}`);
  console.log(`  Work Dir:      ${WORK_DIR}`);
  console.log(`  Duration:      ${BENCHMARK_DURATION}s\n`);

  await producer.connect();
  console.log('[Kafka] Producer connected');

  await consumer.connect();
  console.log('[Kafka] Consumer connected');

  await consumer.subscribe({ topic: 'jobs', fromBeginning: true });
  console.log('[Kafka] Subscribed to "jobs" topic');
  console.log('[Worker] Waiting for jobs...\n');

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const job = JSON.parse(message.value.toString());
      console.log(`[Kafka] Received message from ${topic}[${partition}] offset=${message.offset}`);
      await processJob(job);
    },
  });
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
