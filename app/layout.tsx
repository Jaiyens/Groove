import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, Bricolage_Grotesque, Bungee } from 'next/font/google';
import PhoneFrame from '@/components/PhoneFrame';
import PracticeTracker from '@/components/PracticeTracker';
import { GraphProvider } from '@/lib/graph/context';
import './globals.css';

// Inter remains the body face — neutral, calm, very legible at small sizes.
// SPECK polish §Fix 4: the Groov wordmark moves to Bricolage Grotesque, a
// kinetic display face (squared corners, off-axis terminals, optical-size
// axis) that reads as quirky / weird-but-readable instead of corporate.
// The wordmark layer adds an italic skew + a kicked-up V on top of the
// typeface so the energy doesn't just live in the font.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-inter',
  display: 'swap',
});
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-bricolage',
  display: 'swap',
});
// Bungee — heavy display face used by CalloutOverlay for the live tier
// stamp (GROOVY / PERFECT / GREAT / ALMOST). Picked for character and weight;
// the only place it should appear is the per-beat live callout.
const bungee = Bungee({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-bungee',
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
    <html lang="en" className={`${inter.variable} ${bricolage.variable} ${bungee.variable}`}>
      <body className="bg-cream text-ink">
        <GraphProvider>
          <PracticeTracker />
          <PhoneFrame>{children}</PhoneFrame>
        </GraphProvider>
      </body>
    </html>
  );
}
