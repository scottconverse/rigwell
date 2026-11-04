import { initialState, reduce } from "../../src/tui/reducer.ts";
import type { Effect, TuiEvent, TuiState } from "../../src/tui/types.ts";

export interface Driver { s: TuiState; effects: Effect[]; t: number }

export function driver(over: Partial<TuiState> = {}): Driver {
  return { s: { ...initialState({ cwd: "/work/proj", idPrefix: "t" }), models: [{ id: "m1", displayName: "Model One" }, { id: "m2", displayName: "Model Two" }], modelId: "m1", ...over }, effects: [], t: 1000 };
}

/** Reduces one event and keeps every effect. */
export function rawEv(d: Driver, e: TuiEvent): Driver {
  const r = reduce(d.s, e);
  return { ...d, s: r.state, effects: [...d.effects, ...r.effects] };
}
/** Like rawEv but drops the attention and status-line effects, which most tests do not care about. */
export function ev(d: Driver, e: TuiEvent): Driver {
  const r = rawEv({ ...d, effects: [] }, e);
  return { ...r, effects: [...d.effects, ...r.effects.filter((x) => x.type !== "attention" && x.type !== "status_line")] };
}
export const key = (d: Driver, name: string, text?: string, dt = 10): Driver => { const n = { ...d, t: d.t + dt }; return ev(n, { type: "key", key: { name, text }, now: n.t }); };
export const type = (d: Driver, text: string): Driver => key(d, "char", text);
export const note = (d: Driver, n: { type: string; [k: string]: any }): Driver => ev(d, { type: "notification", n, now: d.t });
export const take = (d: Driver): [Effect[], Driver] => [d.effects, { ...d, effects: [] }];
