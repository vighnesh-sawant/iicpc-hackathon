"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function Home() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const fetchLeaderboard = async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/leaderboard`);
      const data = await res.json();
      setLeaderboard(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (localStorage.getItem('username')) {
      setIsLoggedIn(true);
    }
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="container">
      <header className="header">
        <h1>IICPC Leaderboard</h1>
        <div style={{display: 'flex', gap: '1rem'}}>
          {!isLoggedIn && (
            <>
              <Link href="/login" style={{color: 'var(--accent-color)', fontWeight: 'bold'}}>Login</Link>
              <Link href="/register" style={{color: 'var(--accent-color)', fontWeight: 'bold'}}>Register</Link>
            </>
          )}
          {isLoggedIn && (
            <Link href="/profile" style={{color: 'var(--accent-color)', fontWeight: 'bold'}}>My Profile</Link>
          )}
        </div>
      </header>

      <div className="leaderboard-grid">
        {leaderboard.map((user, index) => (
          <div key={user.username} className="team-card" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <h2>#{index + 1} {user.username}</h2>
            <div style={{fontSize: '1.5rem', color: 'var(--accent-color)', fontWeight: 'bold'}}>
              {user.bestScore > 0 ? `AUC: ${Math.round(user.bestScore).toLocaleString()}` : 'No completed runs'}
            </div>
          </div>
        ))}
        {leaderboard.length === 0 && <p>No users registered yet.</p>}
      </div>
    </main>
  );
}
