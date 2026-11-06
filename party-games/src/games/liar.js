// 라이어 게임: 한 명만 제시어를 모른다. 돌아가며 힌트를 말하고, 투표로 라이어를 찾는다.
import { shuffle, pick, nameMap, arm, remain, isTimer } from "./util.js";
import { CATEGORIES } from "./words.js";

const HINT_MS = 40000;
const VOTE_MS = 60000;
const GUESS_MS = 30000;

function nextHint(s, ctx) {
  s.hintIdx++;
  if (s.hintIdx >= s.order.length * s.hintRounds) {
    s.phase = "vote";
    s.votes = {};
    arm(s, ctx, VOTE_MS, "vote");
  } else arm(s, ctx, HINT_MS, "hint");
}

function tally(s, ctx) {
  const count = {};
  for (const t of Object.values(s.votes)) count[t] = (count[t] || 0) + 1;
  s.tally = count;
  const top = Math.max(0, ...Object.values(count));
  const tops = Object.keys(count).filter((id) => count[id] === top);
  if (top === 0 || tops.length > 1) {
    s.accused = null;
    finish(s, false, "표가 갈렸어요. 라이어가 몰래 빠져나갔습니다!");
  } else if (tops[0] !== s.liar) {
    s.accused = tops[0];
    finish(s, false, `${s.names[tops[0]]}님은 라이어가 아니었어요!`);
  } else {
    s.accused = s.liar;
    s.phase = "guess";
    arm(s, ctx, GUESS_MS, "guess");
  }
}

function finish(s, citizensWin, text) {
  s.phase = "done";
  s.deadline = 0;
  const citizens = s.order.filter((id) => id !== s.liar);
  s.over = {
    winners: citizensWin ? citizens : [s.liar],
    losers: citizensWin ? [s.liar] : citizens,
    text: `${text} ${citizensWin ? "🕵️ 시민 승리!" : `🤥 라이어(${s.names[s.liar]}) 승리!`}`,
  };
}

export default {
  id: "liar",
  name: "라이어 게임",
  emoji: "🤥",
  min: 3,
  max: 8,
  short: "나만 모르는 제시어! 힌트로 라이어를 찾아라.",
  rules: [
    "라이어 한 명만 제시어를 모르고 주제만 압니다.",
    "차례대로 제시어에 대한 힌트를 한 줄씩 씁니다. 라이어는 들키지 않게 아는 척!",
    "모두 힌트를 쓰면 라이어라고 생각하는 사람에게 투표합니다.",
    "라이어가 지목되면, 라이어가 제시어를 맞히면 라이어 승리. 못 맞히면 시민 승리.",
  ],
  setup(players, ctx) {
    const category = pick(Object.keys(CATEGORIES), ctx.random);
    const s = {
      order: shuffle(players.map((p) => p.id), ctx.random),
      names: nameMap(players),
      category,
      word: pick(CATEGORIES[category], ctx.random),
      liar: pick(players, ctx.random).id,
      phase: "hint",
      hintRounds: players.length <= 4 ? 2 : 1,
      hintIdx: 0,
      hints: [],
      votes: {},
      tally: null,
      accused: null,
      guess: null,
      over: null,
    };
    arm(s, ctx, HINT_MS, "hint");
    return s;
  },
  action(s, pid, a, ctx) {
    if (s.over) return "게임이 끝났어요";
    if (!a) return "알 수 없는 동작";
    if (a.type === "hint") {
      if (s.phase !== "hint") return "힌트 시간이 아니에요";
      if (s.order[s.hintIdx % s.order.length] !== pid) return "내 차례가 아니에요";
      const text = String(a.text || "").trim().slice(0, 40);
      if (!text) return "힌트를 써 주세요";
      s.hints.push({ pid, text });
      nextHint(s, ctx);
    } else if (a.type === "vote") {
      if (s.phase !== "vote") return "투표 시간이 아니에요";
      if (!s.order.includes(a.target) || a.target === pid) return "다른 사람을 골라 주세요";
      s.votes[pid] = a.target;
      if (s.order.every((id) => s.votes[id])) tally(s, ctx);
    } else if (a.type === "guess") {
      if (s.phase !== "guess" || pid !== s.liar) return "라이어만 맞힐 수 있어요";
      s.guess = String(a.word || "");
      if (s.guess === s.word) finish(s, false, `라이어가 제시어 '${s.word}'를 맞혔어요!`);
      else finish(s, true, `라이어가 '${s.guess}'라고 했지만 정답은 '${s.word}'!`);
    } else return "알 수 없는 동작";
  },
  timer(s, key, ctx) {
    if (s.over) return;
    if (s.phase === "hint" && isTimer(s, key, "hint")) {
      s.hints.push({ pid: s.order[s.hintIdx % s.order.length], text: "(시간 초과)", auto: true });
      nextHint(s, ctx);
    } else if (s.phase === "vote" && isTimer(s, key, "vote")) {
      tally(s, ctx);
    } else if (s.phase === "guess" && isTimer(s, key, "guess")) {
      finish(s, true, `라이어가 시간 안에 답하지 못했어요. 정답은 '${s.word}'!`);
    }
  },
  view(s, pid, ctx) {
    const isLiar = pid === s.liar;
    const playing = s.order.includes(pid);
    const reveal = !!s.over;
    return {
      phase: s.phase,
      category: s.category,
      role: !playing ? "spectator" : isLiar ? "liar" : "citizen",
      word: reveal || (playing && !isLiar) ? s.word : null,
      choices: s.phase === "guess" || reveal ? CATEGORIES[s.category] : null,
      order: s.order.map((id) => ({ id, name: s.names[id] })),
      turnId: s.phase === "hint" ? s.order[s.hintIdx % s.order.length] : null,
      hintRound: Math.floor(s.hintIdx / s.order.length) + 1,
      hintRounds: s.hintRounds,
      hints: s.hints,
      voted: Object.keys(s.votes),
      myVote: s.votes[pid] || null,
      tally: s.tally,
      accused: s.accused,
      liar: reveal || s.phase === "guess" ? s.liar : null,
      guess: s.guess,
      remainMs: s.over ? 0 : remain(s, ctx),
    };
  },
};
