'use client';

import { useEffect } from 'react';
import { ensureFirstOpenTimestamp } from '@/lib/practiceStats';

export default function PracticeTracker() {
  useEffect(() => {
    ensureFirstOpenTimestamp();
  }, []);

  return null;
}
