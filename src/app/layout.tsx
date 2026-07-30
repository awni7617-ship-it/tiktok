import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Phantom — AI content studio',
    template: '%s · Phantom',
  },
  description:
    'Turn a raw idea into a fully edited, optimised and scheduled short-form video. AI does the repetitive work; you approve everything before it publishes.',
  applicationName: 'Phantom',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0b14' },
    { media: '(prefers-color-scheme: light)', color: '#fafaff' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored theme before first paint. Without this the page
          renders in the default theme and then flips, which is far more
          jarring than the small inline script it costs.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('phantom-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <a href="#main" className="skip-link focus:left-4 focus:top-4">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
