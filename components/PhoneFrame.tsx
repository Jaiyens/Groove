import type { ReactNode } from 'react';

interface PhoneFrameProps {
  children: ReactNode;
}

export default function PhoneFrame({ children }: PhoneFrameProps) {
  return (
    <div className="min-h-dvh w-full bg-black flex items-center justify-center md:p-8">
      <div className="phone-shell">
        <div className="phone-screen">{children}</div>
      </div>
      <style>{`
        .phone-shell {
          width: 100%;
          min-height: 100dvh;
          background: #000;
          position: relative;
        }
        @media (min-width: 600px) {
          .phone-shell {
            width: 430px;
            min-height: 0;
            height: 932px;
            max-height: calc(100dvh - 64px);
            background: #0a0a0a;
            border-radius: 56px;
            padding: 14px;
            box-shadow: 0 0 0 1.5px #2a2a30, 0 30px 60px -20px rgba(254, 44, 85, 0.15),
              0 0 0 6px #1c1c20;
          }
        }
        .phone-screen {
          width: 100%;
          height: 100%;
          background: #000;
          border-radius: 0;
          overflow: hidden;
          position: relative;
        }
        @media (min-width: 600px) {
          .phone-screen {
            border-radius: 46px;
            height: 904px;
            max-height: calc(100dvh - 92px);
          }
        }
      `}</style>
    </div>
  );
}
