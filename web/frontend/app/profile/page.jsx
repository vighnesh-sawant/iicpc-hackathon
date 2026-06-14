"use client";

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function Profile() {
  const [username, setUsername] = useState('');
  const [runs, setRuns] = useState([]);
  const fileInputRef = useRef(null);
  const router = useRouter();

  const fetchProfile = async (user) => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/profile/${user}`);
      const data = await res.json();
      setRuns((data.runs || []).sort((a,b) => b.id - a.id));
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    const storedUser = localStorage.getItem('username');
    if (!storedUser) {
      router.push('/login');
    } else {
      setUsername(storedUser);
      fetchProfile(storedUser);
      const interval = setInterval(() => fetchProfile(storedUser), 2000);
      return () => clearInterval(interval);
    }
  }, [router]);

  const handleUpload = async () => {
    const file = fileInputRef.current?.files[0];
    if (!file) return alert('Please select a binary to upload');

    const formData = new FormData();
    formData.append('binary', file);
    formData.append('username', username);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/upload`, {
        method: 'POST',
        body: formData
      });
      const result = await response.json();
      alert(result.message || result.error);
      fetchProfile(username);
    } catch (err) {
      alert('Upload failed: ' + err.message);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('username');
    router.push('/');
  }

  if (!username) return null;

  return (
    <main className="container">
      <header className="header">
        <h1>{username}'s Profile</h1>
        <div style={{display: 'flex', gap: '1rem'}}>
          <Link href="/" style={{color: 'var(--accent-color)', fontWeight: 'bold'}}>Leaderboard</Link>
          <button onClick={handleLogout} style={{background: 'transparent', border: 'none', color: 'var(--error-color)', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem', textTransform: 'uppercase'}}>Logout</button>
        </div>
      </header>

      <section className="upload-section">
        <h3>Deploy Engine:</h3>
        <input type="file" ref={fileInputRef} />
        <button onClick={handleUpload}>Upload & Run Sandbox</button>
      </section>

      <h2>My Execution History</h2>
      
      <div className="leaderboard-grid">
        {runs.map((run, index) => (
          <div key={run.id} className="team-card">
            <div className="team-header">
              <h2>Run #{runs.length - index} ({new Date(parseInt(run.id)).toLocaleTimeString()})</h2>
              <div style={{fontSize: '1.2rem', color: run.status === 'completed' ? 'var(--accent-color)' : '#aaa', fontWeight: 'bold'}}>
                Status: {run.status.toUpperCase()}
              </div>
            </div>
            
            {run.status === 'completed' ? (
              <>
                <div className="metrics">
                  <div className="metric">AUC Score: <span>{Math.round(run.aucScore).toLocaleString()}</span></div>
                  <div className="metric">Baseline Latency: <span>{run.baselineLatency.toFixed(2)} ms</span></div>
                </div>

                {run.correctnessTests && run.correctnessTests.length > 0 && (
                  <div style={{margin: '1rem 0', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px'}}>
                    <h4 style={{margin: '0 0 0.5rem 0', color: 'var(--text-primary)'}}>Correctness Tests</h4>
                    <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.5rem'}}>
                      {run.correctnessTests.map((t, i) => (
                        <div key={i} style={{display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem'}}>
                          <span style={{color: t.passed ? '#6ee7b7' : '#f87171'}}>{t.passed ? '✓' : '✗'}</span>
                          <span style={{color: 'var(--text-primary)'}}>{t.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="chart-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={[...run.dataPoints].sort((a, b) => a.tps - b.tps)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                      <XAxis dataKey="tps" type="number" domain={['dataMin', 'dataMax']} stroke="var(--text-primary)" tickFormatter={(val) => `${(val/1000).toFixed(1)}k`} />
                      <YAxis domain={[0, 'dataMax']} stroke="var(--text-primary)" label={{ value: 'p99 Latency (ms)', angle: -90, position: 'insideLeft', fill: 'var(--text-primary)' }} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div style={{ backgroundColor: 'var(--surface-color)', border: '1px solid var(--accent-dark)', padding: '0.75rem', borderRadius: '8px', fontSize: '0.85rem' }}>
                            <div style={{ color: 'var(--text-primary)', marginBottom: '0.25rem' }}><strong>TPS:</strong> {d.tps.toLocaleString()}</div>
                            <div style={{ color: '#6ee7b7' }}>p50: {d.p50 != null ? `${d.p50} ms` : '—'}</div>
                            <div style={{ color: '#fbbf24' }}>p90: {d.p90 != null ? `${d.p90} ms` : '—'}</div>
                            <div style={{ color: 'var(--accent-color)' }}>p99: {d.p99} ms</div>
                          </div>
                        );
                      }} />
                      <Line type="monotone" dataKey="p99" stroke="var(--accent-color)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : (
              <p style={{color: 'var(--text-primary)'}}>Run is currently executing in the sandbox. Results and charts will appear once the benchmark concludes...</p>
            )}
          </div>
        ))}
        {runs.length === 0 && <p>You haven't uploaded any engines yet. Upload a binary to begin your first benchmark.</p>}
      </div>
    </main>
  );
}
