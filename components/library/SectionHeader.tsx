interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
}

export default function SectionHeader({ title, subtitle, rightSlot }: SectionHeaderProps) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <div>
        <h2 className="font-serif text-2xl leading-none text-ink">{title}</h2>
        {subtitle && (
          <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
        )}
      </div>
      {rightSlot && <div className="text-sm text-ink-muted">{rightSlot}</div>}
    </div>
  );
}
