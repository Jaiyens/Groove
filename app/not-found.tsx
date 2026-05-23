import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <div className="text-5xl font-extrabold tabular-nums">404</div>
      <p className="mt-3 text-ink-muted">That page doesn&apos;t exist.</p>
      <Link
        href="/"
        className="mt-6 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black"
      >
        Back home
      </Link>
    </main>
  );
}
