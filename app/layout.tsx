import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import PhoneFrame from '@/components/PhoneFrame';
import { GraphProvider } from '@/lib/graph/context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Groove',
  description: 'Learn TikTok choreography with live pose feedback.',
  applicationName: 'Groove',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#000000',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-black text-white">
        <GraphProvider>
          <PhoneFrame>{children}</PhoneFrame>
        </GraphProvider>
      </body>
    </html>
  );
}
