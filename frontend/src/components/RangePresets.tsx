const iso = (d: Date) => d.toISOString().slice(0, 10);

const PRESETS: [string, number][] = [
  ["3D", 3],
  ["7D", 7],
  ["15D", 15],
  ["1M", 30],
];

/** Quick "last N days" chips that set a from/to date range. */
export function RangePresets({
  set,
  active,
}: {
  set: (from: string, to: string) => void;
  active?: string; // current `from` value, to highlight the matching chip
}) {
  const today = iso(new Date());
  return (
    <span className="flex items-center gap-0.5">
      {PRESETS.map(([label, days]) => {
        const d = new Date();
        d.setDate(d.getDate() - days);
        const from = iso(d);
        return (
          <button
            key={label}
            onClick={() => set(from, today)}
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              active === from
                ? "border-term-accent bg-term-accent/20 text-term-text"
                : "border-term-border text-term-dim hover:text-term-text"
            }`}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}
