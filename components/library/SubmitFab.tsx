'use client';

interface SubmitFabProps {
  onClick: () => void;
}

export default function SubmitFab({ onClick }: SubmitFabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Submit a TikTok"
      className="fixed min-[600px]:absolute bottom-[calc(64px+env(safe-area-inset-bottom)+16px)] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#FF1F8E] text-white shadow-lg transition-transform active:scale-95"
    >
      <svg
        width={26}
        height={26}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}
