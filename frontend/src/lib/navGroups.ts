import type { View } from "../types";

export type NavGroup = {
  key: string;
  label: string;
  icon: string;
  /** [view, label][] -- first entry is the group's default landing view */
  members: [View, string][];
};

/** The app's 4 top-level sections. Chart/OI/Trend OI were three separate
 *  nav items that all just look at "this symbol right now" from a
 *  different angle, so they're one section with the same symbol carried
 *  across; Scalp/Build/Positions/Orders/Auto are the ones that actually
 *  place or manage a trade (Auto included -- it's an automated trading
 *  engine, not just account admin); Journal/Funds are account-level, not
 *  symbol-scoped. Scan stays alone -- it already has its own sub-tabs
 *  (Gamma Blast/Movers/Screener/History/Indicators) and doesn't share a
 *  symbol context with the others the way the Chart group does. */
export const NAV_GROUPS: NavGroup[] = [
  {
    key: "chart",
    label: "Chart",
    icon: "📈",
    members: [
      ["chart", "Chart"],
      ["scrip", "OI"],
      ["trendingoi", "Trend OI"],
      ["flow", "Flow"],
      ["orderflow", "OrderFlow"],
      ["vol", "Vol"],
    ],
  },
  {
    key: "trade",
    label: "Trade",
    icon: "🧱",
    members: [
      ["scalper", "Scalp"],
      ["builder", "Build"],
      ["positions", "Positions"],
      ["orders", "Orders"],
      ["auto", "Auto"],
    ],
  },
  {
    key: "scan",
    label: "Scan",
    icon: "📡",
    members: [["scanner", "Scan"]],
  },
  {
    key: "account",
    label: "Account",
    icon: "💰",
    members: [
      ["journal", "Journal"],
      ["funds", "Funds"],
    ],
  },
];

export function groupForView(v: View): NavGroup | undefined {
  return NAV_GROUPS.find((g) => g.members.some(([mv]) => mv === v));
}
