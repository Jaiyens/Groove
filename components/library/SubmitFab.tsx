'use client';

interface SubmitFabProps {
  onClick: () => void;
  variant?: 'floating' | 'fixed';
}

export default function SubmitFab({ onClick, variant = 'floating' }: SubmitFabProps) {
  return (
    <div className={variant === 'floating' ? 'absolute inset-x-0 bottom-[68px] z-30 flex justify-center pb-3' : 'flex justify-center'}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3.5 text-base font-semibold text-white shadow-lift active:scale-[0.98]"
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        submit a tiktok
      </button>
    </div>
  );
}
