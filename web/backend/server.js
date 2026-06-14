const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Kafka } = require('kafkajs');
const { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// --- Configuration ---
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://iicpc:iicpc_secret@localhost:5432/iicpc';

// --- PostgreSQL Setup ---
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

let dbReady = false;

async function initDatabase() {
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      const client = await pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          auc_score REAL DEFAULT 0,
          max_tps INTEGER DEFAULT 0,
          baseline_latency REAL DEFAULT 0,
          data_points JSONB DEFAULT '[]'::jsonb,
          error TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS correctness_tests JSONB DEFAULT '[]'::jsonb`);
      await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS max_tps_before_failure INTEGER DEFAULT 0`);
      client.release();
      dbReady = true;
      console.log('[DB] PostgreSQL connected and tables created');
      return;
    } catch (err) {
      console.error(`[DB] Attempt ${attempt}/15: PostgreSQL not ready - ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.error('[DB] FATAL: Could not connect to PostgreSQL after 15 attempts');
  process.exit(1);
}

// --- S3 Client Setup ---
const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true
});

async function ensureBucket() {
  for (let i = 0; i < 5; i++) {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: 'engines' }));
      console.log("'engines' bucket exists.");
      return;
    } catch (err) {
      try {
        console.log("Creating 'engines' bucket...");
        await s3Client.send(new CreateBucketCommand({ Bucket: 'engines' }));
        return;
      } catch (inner) {
        console.error(`Attempt ${i+1}: S3 not ready yet...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

// --- Kafka Client Setup ---
const kafka = new Kafka({
  clientId: 'iicpc-backend',
  brokers: [KAFKA_BROKER],
  retry: { retries: 5, initialRetryTime: 1000 },
});
const admin = kafka.admin();
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'iicpc-web-group' });

let kafkaReady = false;

async function startKafka() {
  try {
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic: 'jobs', numPartitions: 5, replicationFactor: 1 },
        { topic: 'telemetry', numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();
    console.log("[Kafka] Topics created/verified: 'jobs', 'telemetry'");

    await producer.connect();
    console.log("[Kafka] Producer connected");

    await consumer.connect();
    await consumer.subscribe({ topic: 'telemetry', fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const data = JSON.parse(message.value.toString());
        console.log(`[Kafka] Telemetry received: run=${data.id} status=${data.status} ` +
                     `maxTps=${data.maxTps || 0} auc=${data.aucScore || 0}`);

        // Idempotent upsert — safe to replay
        try {
          await pool.query(`
            INSERT INTO runs (id, username, status, auc_score, max_tps, baseline_latency, data_points, error, correctness_tests, max_tps_before_failure)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              auc_score = EXCLUDED.auc_score,
              max_tps = EXCLUDED.max_tps,
              baseline_latency = EXCLUDED.baseline_latency,
              data_points = EXCLUDED.data_points,
              error = EXCLUDED.error,
              correctness_tests = EXCLUDED.correctness_tests,
              max_tps_before_failure = EXCLUDED.max_tps_before_failure
          `, [
            data.id,
            data.username,
            data.status,
            data.aucScore || 0,
            data.maxTps || 0,
            data.baselineLatency || 0,
            JSON.stringify(data.dataPoints || []),
            data.error || null,
            JSON.stringify(data.correctnessTests || []),
            data.maxTpsBeforeFailure || 0,
          ]);
          console.log(`[DB] Run ${data.id} upserted with status=${data.status}`);
        } catch (dbErr) {
          console.error(`[DB] Failed to upsert run ${data.id}:`, dbErr.message);
        }
      },
    });
    kafkaReady = true;
    console.log("[Kafka] Consumer subscribed to 'telemetry' topic");
    console.log("[Kafka] Full pipeline ready: Upload -> S3 -> Kafka(jobs) -> Worker -> Kafka(telemetry) -> Backend -> PostgreSQL");
  } catch (e) {
    console.error("[Kafka] Offline, using local mock mode.", e.message);
  }
}

// --- Health endpoint (used by liveness/readiness probes) ---
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', db: true, kafka: kafkaReady });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// --- API Routes ---
const upload = multer({ dest: 'temp_uploads/' });

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
    console.log(`[API] User registered: ${username}`);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Taken' });
    console.error('[API] Registration error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid' });
    res.json({ success: true, username });
  } catch (err) {
    console.error('[API] Login error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.username, COALESCE(MAX(r.auc_score), 0) AS "bestScore"
      FROM users u
      LEFT JOIN runs r ON r.username = u.username AND r.status = 'completed'
      GROUP BY u.username
      ORDER BY "bestScore" DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/profile/:username', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, status, auc_score AS "aucScore", max_tps AS "maxTps", baseline_latency AS "baselineLatency", data_points AS "dataPoints", error, correctness_tests AS "correctnessTests", max_tps_before_failure AS "maxTpsBeforeFailure" FROM runs WHERE username = $1 ORDER BY created_at DESC',
      [req.params.username]
    );
    res.json({ username: req.params.username, runs: result.rows });
  } catch (err) {
    console.error('[API] Profile error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/upload', upload.single('binary'), async (req, res) => {
  const { username } = req.body;
  if (!username || !req.file) return res.status(400).json({ error: 'Missing' });

  const runId = Date.now().toString();
  const s3Key = `${username}/${runId}`;

  try {
    // 1. Store binary in S3 (MinIO)
    const fileContent = fs.readFileSync(req.file.path);
    await s3Client.send(new PutObjectCommand({
      Bucket: 'engines', Key: s3Key, Body: fileContent
    }));
    console.log(`[S3] Binary uploaded: s3://engines/${s3Key} (${fileContent.length} bytes)`);

    // 2. Insert queued run into PostgreSQL
    await pool.query(
      'INSERT INTO runs (id, username, status) VALUES ($1, $2, $3)',
      [runId, username, 'queued']
    );
    console.log(`[DB] Run ${runId} inserted with status=queued`);

    fs.unlinkSync(req.file.path);

    // 3. Publish execution job to Kafka 'jobs' topic
    if (kafkaReady) {
      const jobPayload = { runId, username, s3Key, bucket: 'engines' };
      await producer.send({
        topic: 'jobs',
        messages: [{ key: runId, value: JSON.stringify(jobPayload) }]
      });
      console.log(`[Kafka] Job published to 'jobs' topic: ${runId} for ${username}`);
      res.json({ message: 'Queued for execution', runId });
    } else {
      // Fallback: mock result when Kafka is offline
      console.log(`[Mock] Kafka offline — simulating benchmark for ${runId}`);
      setTimeout(async () => {
        try {
          await pool.query(`
            UPDATE runs SET status = 'completed', max_tps = 5000000, baseline_latency = 0.05,
              auc_score = 850000, data_points = $1 WHERE id = $2
          `, [JSON.stringify([{tps: 100000, p50: 0.005, p90: 0.008, p99: 0.01}, {tps: 5000000, p50: 0.025, p90: 0.058, p99: 0.09}]), runId]);
        } catch (e) { console.error('[Mock] DB error:', e.message); }
      }, 5000);
      res.json({ message: 'Queued (mock mode)', runId });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'S3/Kafka Error' });
  }
});

// --- Graceful Shutdown ---
async function shutdown(signal) {
  console.log(`[Shutdown] Received ${signal}, draining connections...`);
  try { await consumer.disconnect(); } catch {}
  try { await producer.disconnect(); } catch {}
  try { await pool.end(); } catch {}
  console.log('[Shutdown] Cleanup complete, exiting');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Boot Sequence ---
const PORT = 3001;

async function boot() {
  await initDatabase();
  await ensureBucket().catch(console.error);
  await startKafka();
  app.listen(PORT, () => console.log(`IICPC Backend running on port ${PORT}`));
}

boot().catch(err => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
