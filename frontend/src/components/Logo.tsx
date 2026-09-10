/** GammaTerminal mark — a γ monogram in a rounded tile, and the full wordmark
 *  lockup. Both follow the theme (tile = panel, γ = accent). */

export function LogoMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={`shrink-0 ${className}`}
      aria-label="GammaTerminal"
    >
      <rect width="100" height="100" rx="23" className="fill-term-panel" />
      <path
        d="M27 30 L50 62 L50 86 M73 30 L50 62"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-term-accent"
      />
    </svg>
  );
}

export function LogoWordmark({ mark = 22 }: { mark?: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2" title="GammaTerminal">
      <LogoMark size={mark} />
      <span className="flex flex-col leading-none">
        <span className="font-mono text-[13px] font-extrabold tracking-[0.06em] text-term-text">
          GAMMA
        </span>
        <span className="font-mono text-[7px] font-semibold tracking-[0.34em] text-term-dim">
          TERMINAL
        </span>
      </span>
    </span>
  );
}
