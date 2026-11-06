// 베스킨라빈스 31: 차례대로 1~3개의 숫자를 이어 말하고, 31을 말하면 진다.
import { shuffle, nameMap, arm, remain, isTimer } from "./util.js";

const TURN_MS = 15000;
const TARGET = 31;

function advance(s, pid, n, ctx, auto = false) {
  const from = s.count + 1;
  const to = Math.min(TARGET, s.count + n);
  s.count = to;
  s.history.push({ pid, from, to, auto });
  if (to >= TARGET) {
    s.over = {
      losers: [pid],
      winners: s.order.filter((id) => id !== pid),
      text: `${s.names[pid]}님이 ${TARGET}을 말했어요! 💥`,
    };
    s.deadline = 0;
    return;
  }
  s.turn = (s.turn + 1) % s.order.length;
  arm(s, ctx, TURN_MS);
}

export default {
  id: "br31",
  name: "베스킨라빈스 31",
  emoji: "🍦",
  min: 2,
  max: 8,
  short: "숫자를 1~3개씩 이어 말하기. 31을 말하면 탈락!",
  rules: [
    "차례대로 앞 사람 다음 숫자부터 1~3개를 말합니다.",
    "31을 말하게 되는 사람이 집니다.",
    "15초 안에 고르지 않으면 숫자 1개를 자동으로 말해요.",
  ],
  setup(players, ctx) {
    const s = {
      order: shuffle(players.map((p) => p.id), ctx.random),
      names: nameMap(players),
      count: 0,
      turn: 0,
      history: [],
      over: null,
    };
    arm(s, ctx, TURN_MS);
    return s;
  },
  action(s, pid, a, ctx) {
    if (s.over) return "게임이 끝났어요";
    if (!a || a.type !== "say") return "알 수 없는 동작";
    if (s.order[s.turn] !== pid) return "내 차례가 아니에요";
    const n = Number(a.n);
    if (![1, 2, 3].includes(n)) return "1~3개만 말할 수 있어요";
    advance(s, pid, n, ctx);
  },
  timer(s, key, ctx) {
    if (s.over || !isTimer(s, key)) return;
    advance(s, s.order[s.turn], 1, ctx, true);
  },
  view(s, pid, ctx) {
    return {
      order: s.order.map((id) => ({ id, name: s.names[id] })),
      count: s.count,
      target: TARGET,
      turnId: s.over ? null : s.order[s.turn],
      remainMs: s.over ? 0 : remain(s, ctx),
      history: s.history.slice(-12),
    };
  },
};
