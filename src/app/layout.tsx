import type { Metadata, Viewport } from 'next';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Autoreel', template: '%s · Autoreel' },
  description: 'Pick a niche. Get faceless short-form video on autopilot.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0f' },
    { media: '(prefers-color-scheme: light)', color: '#fafafc' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <div className="min-h-screen">
          <Nav />
          <main id="main" className="mx-auto max-w-5xl px-5 py-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
