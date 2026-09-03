import { useStore } from "../store";

export function ConnBadge() {
  const conn = useStore((s) => s.conn);
  const map = {
    open: { c: "bg-up", t: "LIVE" },
    connecting: { c: "bg-yellow-500 animate-pulse", t: "CONNECTING" },
    closed: { c: "bg-down", t: "OFFLINE" },
  } as const;
  const { c, t } = map[conn];
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-term-dim">
      <span className={`h-2 w-2 rounded-full ${c}`} />
      {t}
    </span>
  );
}
