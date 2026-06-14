"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function Register() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const router = useRouter();

  const handleRegister = async (e) => {
    e.preventDefault();
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/register`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ username, password })
    });
    if (res.ok) {
      localStorage.setItem('username', username);
      router.push('/profile');
    } else {
      alert('Registration failed. Username might be taken.');
    }
  };

  return (
    <main className="container">
      <header className="header">
        <h1>Register</h1>
        <Link href="/" style={{color: 'var(--accent-color)'}}>Back to Leaderboard</Link>
      </header>
      <form onSubmit={handleRegister} style={{display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '300px'}}>
        <input placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} style={{padding:'0.5rem', borderRadius:'4px', border:'1px solid var(--accent-dark)', background:'var(--bg-color)', color:'var(--text-primary)'}} required />
        <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} style={{padding:'0.5rem', borderRadius:'4px', border:'1px solid var(--accent-dark)', background:'var(--bg-color)', color:'var(--text-primary)'}} required />
        <button type="submit" style={{padding:'0.5rem', backgroundColor:'var(--accent-dark)', color:'#fff', border:'none', borderRadius:'4px', fontWeight:'bold', cursor:'pointer'}}>Register</button>
      </form>
    </main>
  );
}
