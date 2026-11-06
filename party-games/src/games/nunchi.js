// 눈치 게임: 1부터 차례 없이 아무나 숫자를 외친다. 동시에 외치면 둘 다 탈락, 끝까지 못 외친 사람도 탈락.
import { nameMap, arm, remain, isTimer } from "./util.js";

const READY_MS = 3000;
export const WINDOW_MS = 600; // 이 시간 안에 두 사람이 누르면 '동시에' 외친 것

export default {
  id: "nunchi",
  name: "눈치 게임",
  emoji: "👀",
  min: 3,
  max: 8,
  short: "1부터 아무나 외치기! 겹치거나 마지막이면 탈락.",
  rules: [
    "시작하면 1부터 순서 없이 아무나 버튼을 눌러 다음 숫자를 외칩니다.",
    `거의 동시에(${WINDOW_MS / 1000}초 안에) 두 사람이 외치면 둘 다 집니다.`,
    "끝까지 숫자를 못 외친 마지막 한 사람도 집니다.",
  ],
  setup(players, ctx) {
    const s = {
      order: players.map((p) => p.id),
      names: nameMap(players),
      phase: "ready",
      claims: [],
      over: null,
    };
    arm(s, ctx, READY_MS, "ready");
    return s;
  },
  action(s, pid, a, ctx) {
    if (s.over) return "게임이 끝났어요";
    if (!a || a.type !== "shout") return "알 수 없는 동작";
    if (s.phase !== "play") return "아직이에요!";
    if (s.claims.some((c) => c.pid === pid)) return "이미 외쳤어요";
    const now = ctx.now();
    const last = s.claims[s.claims.length - 1];
    if (last && now - last.t < WINDOW_MS) {
      s.claims.push({ pid, num: last.num, t: now, clash: true });
      last.clash = true;
      s.over = {
        losers: [last.pid, pid],
        winners: s.order.filter((id) => id !== pid && id !== last.pid),
        text: `💥 ${s.names[last.pid]}, ${s.names[pid]}님이 동시에 ${last.num}!`,
      };
      s.deadline = 0;
      return;
    }
    s.claims.push({ pid, num: s.claims.length + 1, t: now });
    const left = s.order.filter((id) => !s.claims.some((c) => c.pid === id));
    // 남은 사람이 한 명이면, 잠깐 기다렸다가(그 사이 겹칠 수도 있으니) 그 사람이 진다.
    if (left.length === 1) arm(s, ctx, WINDOW_MS, "finish");
  },
  timer(s, key, ctx) {
    if (s.over) return;
    if (s.phase === "ready" && isTimer(s, key, "ready")) {
      s.phase = "play";
      s.deadline = 0;
    } else if (s.phase === "play" && isTimer(s, key, "finish")) {
      const left = s.order.filter((id) => !s.claims.some((c) => c.pid === id));
      if (left.length !== 1) return;
      s.over = {
        losers: left,
        winners: s.order.filter((id) => id !== left[0]),
        text: `😵 ${s.names[left[0]]}님이 끝까지 못 외쳤어요!`,
      };
    }
  },
  view(s, pid, ctx) {
    return {
      phase: s.phase,
      total: s.order.length,
      next: s.claims.length + 1,
      claims: s.claims.map((c) => ({ pid: c.pid, num: c.num, clash: !!c.clash, name: s.names[c.pid] })),
      players: s.order.map((id) => ({ id, name: s.names[id], shouted: s.claims.some((c) => c.pid === id) })),
      mine: s.claims.find((c) => c.pid === pid)?.num ?? null,
      remainMs: s.phase === "ready" ? remain(s, ctx) : 0,
    };
  },
};
