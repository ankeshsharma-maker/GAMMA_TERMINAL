/**
 * Mixed AND / OR condition lists for the AutoBot rule editor ("these 2 with AND, the other 3 with OR").
 *
 * A rule's Entry (or Exit) list stays FLAT. Each condition may carry `grp`, the index of the group it sits in; the
 * rule carries `entryGroups` / `exitGroups` (one `{logic}` per group). `entryLogic` / `exitLogic` is the logic of the
 * whole list when there are no groups (the classic single AND/OR switch), and how the GROUPS combine when there are.
 * Mirrors backend/app/autobot_groups.py, which is what actually evaluates it.
 *
 * Every function here is pure: it takes the list as the editor sees it and returns the next one.
 */
import type { AutoCondition, LogicGroup } from "../types";

export type Logic = "all" | "any";

/** One condition list (Entry or Exit) as the editor sees it. */
export interface CondListState {
  list: AutoCondition[];
  /** undefined = one classic flat list */
  groups?: LogicGroup[];
  /** no groups: the logic of the whole list. Groups: how the groups combine (all = every group, any = one is enough) */
  logic: Logic;
}

export const MAX_GROUPS = 6;

/** the group a condition sits in; a missing, non-numeric or out-of-range tag means group 0 */
export const grpOf = (c: AutoCondition, n: number): number => {
  const g = Math.trunc(Number(c.grp ?? 0));
  return Number.isFinite(g) && g >= 0 && g < n ? g : 0;
};

/** condition indices per group, in list order; a classic list is one group holding everything */
export function members(s: CondListState): number[][] {
  const n = s.groups?.length ?? 1;
  const out: number[][] = Array.from({ length: n }, () => []);
  s.list.forEach((c, i) => out[s.groups ? grpOf(c, n) : 0].push(i));
  return out;
}

const stripGrp = (c: AutoCondition): AutoCondition => {
  const { grp: _g, ...rest } = c;
  return rest as AutoCondition;
};

/** back to one classic list: the lone group's own logic becomes the list's logic and the tags are dropped */
function collapse(list: AutoCondition[], groups: LogicGroup[], fallback: Logic): CondListState {
  return { list: list.map(stripGrp), groups: undefined, logic: groups[0]?.logic ?? fallback };
}

/**
 * Open another group. A classic list first becomes group 1 (keeping its logic); the fresh condition starts the new
 * group, whose own logic is the opposite of the previous group's (the reason to add a group is to mix AND with OR),
 * and the groups are joined by `joinDefault` (Entry: AND, Exit: OR, the same defaults the lists already had).
 */
export function addGroup(s: CondListState, fresh: AutoCondition, joinDefault: Logic): CondListState {
  const base: LogicGroup[] = s.groups ?? [{ logic: s.logic }];
  if (base.length >= MAX_GROUPS) return s;
  const k = base.length;
  const opposite: Logic = base[k - 1].logic === "all" ? "any" : "all";
  return {
    list: [...s.list.map((c) => (s.groups ? c : { ...c, grp: 0 })), { ...fresh, grp: k }],
    groups: [...base, { logic: opposite }],
    logic: s.groups ? s.logic : joinDefault,
  };
}

/** Drop group k with its conditions; the groups after it shift up. Down to one group = a classic list again. */
export function removeGroup(s: CondListState, k: number): CondListState {
  const gs = s.groups;
  if (!gs || k < 0 || k >= gs.length) return s;
  const groups = gs.filter((_, j) => j !== k);
  const list = s.list
    .filter((c) => grpOf(c, gs.length) !== k)
    .map((c) => {
      const g = grpOf(c, gs.length);
      return { ...c, grp: g > k ? g - 1 : g };
    });
  return groups.length <= 1 ? collapse(list, groups, s.logic) : { list, groups, logic: s.logic };
}

/** Add a condition to group k (a classic list has only group 0 and its conditions carry no tag). */
export function addCond(s: CondListState, k: number, fresh: AutoCondition): CondListState {
  return { ...s, list: [...s.list, s.groups ? { ...fresh, grp: Math.min(Math.max(k, 0), s.groups.length - 1) } : fresh] };
}

export function removeCond(s: CondListState, i: number): CondListState {
  return { ...s, list: s.list.filter((_, j) => j !== i) };
}

/** Replace condition i (e.g. its kind was changed) without losing which group it sits in. */
export function setCond(s: CondListState, i: number, nc: AutoCondition): CondListState {
  const keep = s.groups ? { grp: grpOf(s.list[i], s.groups.length) } : {};
  return { ...s, list: s.list.map((c, j) => (j === i ? { ...stripGrp(nc), ...keep } : c)) };
}

/** Move condition i into group k. */
export function moveCond(s: CondListState, i: number, k: number): CondListState {
  if (!s.groups || k < 0 || k >= s.groups.length) return s;
  return { ...s, list: s.list.map((c, j) => (j === i ? { ...c, grp: k } : c)) };
}

export function setGroupLogic(s: CondListState, k: number, logic: Logic): CondListState {
  if (!s.groups) return { ...s, logic };
  return { ...s, groups: s.groups.map((g, j) => (j === k ? { ...g, logic } : g)) };
}

/** The whole rule condition in plain words, e.g. "RSI(14) < 30 AND day is Tue AND (spot up OR PCR > 1)".
 *  A group is bracketed only when its own AND / OR differs from the one joining the groups (the brackets would say nothing). */
export function readout(s: CondListState, describe: (c: AutoCondition) => string): string {
  const word = (l: Logic) => (l === "any" ? " OR " : " AND ");
  const groups: Logic[] = s.groups ? s.groups.map((g) => g.logic) : [s.logic];
  const parts = members(s)
    .map((ix, k) => ({ text: ix.map((i) => describe(s.list[i])), logic: groups[k] }))
    .filter((p) => p.text.length);
  if (!s.groups || parts.length <= 1) return parts.map((p) => p.text.join(word(p.logic))).join("");
  return parts
    .map((p) => {
      const text = p.text.join(word(p.logic));
      return p.text.length > 1 && p.logic !== s.logic ? `(${text})` : text;
    })
    .join(word(s.logic));
}
