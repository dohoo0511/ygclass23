// 반응속도 대결: 초록색이 되는 순간 가장 빨리 누른 사람이 그 판의 승자.
import { nameMap, arm, remain, isTimer } from "./util.js";

const ROUNDS = 5;
const GO_TIMEOUT = 3000;
const REVEAL_MS = 2800;

function startRound(s, ctx) {
  s.round++;
  s.phase = "wait";
  s.times = {};
  s.falses = [];
  s.goAt = 0;
  arm(s, ctx, 1800 + Math.floor(ctx.random() * 3500), "go");
}

function allDone(s) {
  return s.order.every((id) => s.falses.includes(id) || s.times[id] != null);
}

function endRound(s, ctx) {
  let best = null;
  for (const id of s.order) {
    const t = s.times[id];
    if (t != null && (best === null || t < s.times[best])) best = id;
  }
  if (best) s.scores[best]++;
  s.last = { round: s.round, times: { ...s.times }, falses: s.falses.slice(), best };
  if (s.round >= ROUNDS) {
    const top = Math.max(...s.order.map((id) => s.scores[id]));
    const winners = s.order.filter((id) => s.scores[id] === top);
    s.phase = "done";
    s.deadline = 0;
    s.over = {
      winners,
      losers: s.order.filter((id) => !winners.includes(id)),
      text: `⚡ ${winners.map((id) => s.names[id]).join(", ")} 님이 ${top}승으로 우승!`,
    };
    return;
  }
  s.phase = "reveal";
  arm(s, ctx, REVEAL_MS, "next");
}

export default {
  id: "reaction",
  name: "반응속도 대결",
  emoji: "⚡",
  min: 2,
  max: 8,
  short: "초록불이 켜지면 누구보다 빠르게 터치!",
  rules: [
    "빨간 화면에서 기다리다가 초록으로 바뀌면 바로 누르세요.",
    "초록이 되기 전에 누르면 그 판은 실격이에요.",
    `총 ${ROUNDS}판, 가장 많이 1등 한 사람이 우승합니다.`,
  ],
  setup(players, ctx) {
    const s = {
      order: players.map((p) => p.id),
      names: nameMap(players),
      scores: Object.fromEntries(players.map((p) => [p.id, 0])),
      round: 0,
      last: null,
      over: null,
    };
    startRound(s, ctx);
    return s;
  },
  action(s, pid, a, ctx) {
    if (s.over) return "게임이 끝났어요";
    if (!a || a.type !== "tap") return "알 수 없는 동작";
    if (s.falses.includes(pid) || s.times[pid] != null) return;
    if (s.phase === "wait") {
      s.falses.push(pid);
    } else if (s.phase === "go") {
      // 화면이 초록으로 바뀐 순간부터 누를 때까지를 각 기기가 잰다 (서버까지 가는 시간 차이를 없애려고).
      const ms = Math.round(Number(a.ms));
      const byServer = ctx.now() - s.goAt;
      s.times[pid] = Number.isFinite(ms) && ms > 0 ? Math.min(ms, byServer + 50, GO_TIMEOUT) : byServer;
    } else return;
    if (allDone(s)) {
      if (s.phase === "wait") s.deadline = 0;
      endRound(s, ctx);
    }
  },
  timer(s, key, ctx) {
    if (s.over) return;
    if (s.phase === "wait" && isTimer(s, key, "go")) {
      s.phase = "go";
      s.goAt = ctx.now();
      arm(s, ctx, GO_TIMEOUT, "timeout");
    } else if (s.phase === "go" && isTimer(s, key, "timeout")) {
      endRound(s, ctx);
    } else if (s.phase === "reveal" && isTimer(s, key, "next")) {
      startRound(s, ctx);
    }
  },
  view(s, pid, ctx) {
    return {
      phase: s.phase,
      round: s.round,
      rounds: ROUNDS,
      players: s.order.map((id) => ({
        id,
        name: s.names[id],
        score: s.scores[id],
        done: s.times[id] != null,
        false: s.falses.includes(id),
      })),
      myTime: s.times[pid] ?? null,
      myFalse: s.falses.includes(pid),
      last: s.last,
      remainMs: s.phase === "go" ? remain(s, ctx) : 0,
    };
  },
};
