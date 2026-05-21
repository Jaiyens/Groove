import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import PhoneFrame from '@/components/PhoneFrame';
import { GraphProvider } from '@/lib/graph/context';
import './globals.css';

// Inter is the only typeface — see SPECK §Phase 2. Weights 400 + 500 cover
// body and display; we don't load 600/700 deliberately.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'groove',
  description: 'Learn TikTok choreography with live pose feedback.',
  applicationName: 'groove',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#F8F8F6',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-cream text-ink">
        <GraphProvider>
          <PhoneFrame>{children}</PhoneFrame>
        </GraphProvider>
      </body>
    </html>
  );
}
