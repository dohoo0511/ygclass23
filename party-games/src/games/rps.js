// 가위바위보 서바이벌: 모두가 동시에 내고, 진 쪽은 탈락. 마지막 한 명이 남을 때까지.
import { nameMap, arm, remain, isTimer, pick } from "./util.js";

const PICK_MS = 10000;
const REVEAL_MS = 3000;
const HANDS = ["rock", "paper", "scissors"];
const BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };
const LABEL = { rock: "바위", paper: "보", scissors: "가위" };

function newRound(s, ctx) {
  s.round++;
  s.phase = "pick";
  s.picks = {};
  arm(s, ctx, PICK_MS, "pick");
}

function resolve(s, ctx) {
  const auto = [];
  for (const id of s.alive) {
    if (!s.picks[id]) {
      s.picks[id] = pick(HANDS, ctx.random);
      auto.push(id);
    }
  }
  const kinds = [...new Set(s.alive.map((id) => s.picks[id]))];
  let out = [];
  let text;
  if (kinds.length !== 2) {
    text = kinds.length === 1 ? "모두 같은 걸 냈어요. 비겼어요!" : "세 가지가 다 나왔어요. 비겼어요!";
  } else {
    const [a, b] = kinds;
    const win = BEATS[a] === b ? a : b;
    const lose = win === a ? b : a;
    out = s.alive.filter((id) => s.picks[id] === lose);
    text = `${LABEL[win]} 승리! ${out.map((id) => s.names[id]).join(", ")} 탈락`;
  }
  s.last = { round: s.round, picks: { ...s.picks }, out, auto, text };
  s.alive = s.alive.filter((id) => !out.includes(id));
  s.outOrder.push(...out);
  if (s.alive.length <= 1) {
    const w = s.alive[0];
    s.over = { winners: [w], losers: s.order.filter((id) => id !== w), text: `✌️ ${s.names[w]}님이 최후의 1인!` };
    s.phase = "done";
    s.deadline = 0;
    return;
  }
  s.phase = "reveal";
  arm(s, ctx, REVEAL_MS, "reveal");
}

export default {
  id: "rps",
  name: "가위바위보 서바이벌",
  emoji: "✌️",
  min: 2,
  max: 8,
  short: "모두 동시에! 진 사람은 탈락, 최후의 1인을 가려요.",
  rules: [
    "매 판 10초 안에 가위·바위·보 중 하나를 냅니다.",
    "두 가지만 나왔을 때 진 쪽이 모두 탈락. 한 가지나 세 가지면 비겨요.",
    "시간 안에 안 내면 아무거나 자동으로 냅니다.",
  ],
  setup(players, ctx) {
    const s = {
      order: players.map((p) => p.id),
      names: nameMap(players),
      alive: players.map((p) => p.id),
      outOrder: [],
      round: 0,
      picks: {},
      last: null,
      over: null,
    };
    newRound(s, ctx);
    return s;
  },
  action(s, pid, a, ctx) {
    if (s.over) return "게임이 끝났어요";
    if (!a || a.type !== "pick" || !HANDS.includes(a.hand)) return "알 수 없는 동작";
    if (s.phase !== "pick") return "다음 판을 기다려 주세요";
    if (!s.alive.includes(pid)) return "이미 탈락했어요";
    s.picks[pid] = a.hand;
    if (s.alive.every((id) => s.picks[id])) resolve(s, ctx);
  },
  timer(s, key, ctx) {
    if (s.over) return;
    if (s.phase === "pick" && isTimer(s, key, "pick")) resolve(s, ctx);
    else if (s.phase === "reveal" && isTimer(s, key, "reveal")) newRound(s, ctx);
  },
  view(s, pid, ctx) {
    return {
      phase: s.phase,
      round: s.round,
      players: s.order.map((id) => ({
        id,
        name: s.names[id],
        alive: s.alive.includes(id),
        picked: s.phase === "pick" && !!s.picks[id],
      })),
      myPick: s.phase === "pick" ? s.picks[pid] || null : null,
      last: s.last,
      remainMs: s.over ? 0 : remain(s, ctx),
    };
  },
};
