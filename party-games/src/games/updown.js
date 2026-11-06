// 업다운 폭탄: 1~100 사이에 숨은 폭탄 숫자. 범위를 좁혀 가다 폭탄을 고르면 진다.
import { shuffle, nameMap, arm, remain, isTimer } from "./util.js";

const TURN_MS = 20000;
const MAX = 100;

function guess(s, pid, g, ctx, auto = false) {
  if (g === s.secret) {
    s.history.push({ pid, g, r: "BOOM", auto });
    s.over = {
      losers: [pid],
      winners: s.order.filter((id) => id !== pid),
      text: `💣 ${s.names[pid]}님이 폭탄 ${g}을 골랐어요!`,
    };
    s.deadline = 0;
    return;
  }
  if (g < s.secret) {
    s.lo = g;
    s.history.push({ pid, g, r: "UP", auto });
  } else {
    s.hi = g;
    s.history.push({ pid, g, r: "DOWN", auto });
  }
  s.turn = (s.turn + 1) % s.order.length;
  arm(s, ctx, TURN_MS);
}

export default {
  id: "updown",
  name: "업다운 폭탄",
  emoji: "💣",
  min: 2,
  max: 8,
  short: "1~100 속 폭탄 숫자를 피하며 범위를 좁혀요.",
  rules: [
    "1~100 중 하나가 폭탄입니다. 차례대로 숫자를 하나 고릅니다.",
    "폭탄보다 작으면 UP, 크면 DOWN — 범위가 점점 좁아져요.",
    "폭탄 숫자를 고른 사람이 집니다. 20초가 지나면 아무 숫자나 골라져요.",
  ],
  setup(players, ctx) {
    const s = {
      order: shuffle(players.map((p) => p.id), ctx.random),
      names: nameMap(players),
      secret: 1 + Math.floor(ctx.random() * MAX),
      lo: 0,
      hi: MAX + 1,
      turn: 0,
      history: [],
      over: null,
    };
    arm(s, ctx, TURN_MS);
    return s;
  },
  action(s, pid, a, ctx) {
    if (s.over) return "게임이 끝났어요";
    if (!a || a.type !== "guess") return "알 수 없는 동작";
    if (s.order[s.turn] !== pid) return "내 차례가 아니에요";
    const g = Number(a.n);
    if (!Number.isInteger(g) || g <= s.lo || g >= s.hi) return `${s.lo + 1}~${s.hi - 1} 사이 숫자를 골라 주세요`;
    guess(s, pid, g, ctx);
  },
  timer(s, key, ctx) {
    if (s.over || !isTimer(s, key)) return;
    const g = s.lo + 1 + Math.floor(ctx.random() * (s.hi - s.lo - 1));
    guess(s, s.order[s.turn], g, ctx, true);
  },
  view(s, pid, ctx) {
    return {
      order: s.order.map((id) => ({ id, name: s.names[id] })),
      lo: s.lo + 1,
      hi: s.hi - 1,
      turnId: s.over ? null : s.order[s.turn],
      remainMs: s.over ? 0 : remain(s, ctx),
      history: s.history.slice(-12),
      secret: s.over ? s.secret : null,
    };
  },
};
