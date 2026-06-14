import './globals.css';

export const metadata = {
  title: 'IICPC Hackathon 2026',
  description: 'High-Performance Trading Engine Benchmarking Platform',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
