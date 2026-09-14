import type { View } from "../types";
import { groupForView } from "../lib/navGroups";

/** Small segmented row for switching between a nav group's members (e.g.
 *  Chart / OI / Trend OI) without leaving the group. Renders nothing for a
 *  single-member group (Scan) -- there's nothing to switch between. */
export function GroupSubNav({
  view,
  setView,
  className = "",
}: {
  view: View;
  setView: (v: View) => void;
  className?: string;
}) {
  const group = groupForView(view);
  if (!group || group.members.length < 2) return null;
  return (
    <div className={`flex overflow-hidden rounded border border-term-border text-2xs ${className}`}>
      {group.members.map(([v, label]) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`px-2 py-1 font-semibold transition-colors ${
            view === v
              ? "bg-term-accent text-white"
              : "text-term-dim hover:bg-term-border hover:text-term-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
