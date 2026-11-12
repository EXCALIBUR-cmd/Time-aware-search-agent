import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'minimi Chat Agent',
  description: 'A chat agent with web search and time-aware memory',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
