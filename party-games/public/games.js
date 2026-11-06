// 게임마다 화면 그리기. 서버가 보내 준 view 만 보고 그린다.
import { h } from "./dom.js";

function turnBanner(v, c) {
  if (c.over || !v.turnId) return null;
  const mine = v.turnId === c.me;
  return h("div", { class: `turn${mine ? " mine" : ""}` }, mine ? "👉 내 차례!" : `${c.name(v.turnId)}님 차례`, " ", c.cd(v.remainMs));
}

function orderChips(order, c, active, extra) {
  return h(
    "ol",
    { class: "chips" },
    order.map((p) => h("li", { class: `chip${p.id === active ? " on" : ""}${p.id === c.me ? " me" : ""}` }, p.name, extra ? extra(p) : null))
  );
}

function enterSubmit(fn) {
  return (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      fn();
    }
  };
}

const HAND = { rock: "✊", paper: "✋", scissors: "✌️" };
const HAND_NAME = { rock: "바위", paper: "보", scissors: "가위" };

let reactionGo = { key: null, at: 0 };

export const RENDER = {
  // 🍦 베스킨라빈스 31
  br31(v, c) {
    const mine = v.turnId === c.me && c.playing;
    const buttons = [];
    for (let n = 1; n <= 3; n++) {
      if (v.count + n > v.target) break;
      const nums = Array.from({ length: n }, (_, i) => v.count + 1 + i);
      buttons.push(h("button", { class: "btn primary num", onclick: () => c.act({ type: "say", n }) }, nums.join(" · ")));
    }
    return h(
      "div",
      { class: "br31" },
      turnBanner(v, c),
      h("div", { class: "bignum" }, v.count || "0", h("small", null, ` / ${v.target}`)),
      h("div", { class: "bar" }, h("i", { style: `width:${(v.count / v.target) * 100}%` })),
      orderChips(v.order, c, v.turnId),
      mine ? h("div", { class: "row center" }, buttons) : null,
      h(
        "ul",
        { class: "history" },
        v.history
          .slice()
          .reverse()
          .map((x) =>
            h(
              "li",
              { class: x.to >= v.target ? "bad" : "" },
              h("b", null, c.name(x.pid)),
              " ",
              Array.from({ length: x.to - x.from + 1 }, (_, i) => x.from + i).join(", "),
              x.auto ? h("small", { class: "muted" }, " (시간 초과)") : null
            )
          )
      )
    );
  },

  // 💣 업다운 폭탄
  updown(v, c) {
    const mine = v.turnId === c.me && c.playing;
    const submit = () => {
      const el = document.getElementById("ud-input");
      const n = Number(el.value);
      if (!el.value) return;
      c.act({ type: "guess", n });
      el.value = "";
    };
    const pct = (n) => ((n - 1) / 99) * 100;
    return h(
      "div",
      { class: "updown" },
      turnBanner(v, c),
      v.secret != null
        ? h("div", { class: "bignum bad" }, "💣 ", v.secret)
        : h("div", { class: "bignum" }, v.lo, h("small", null, " ~ "), v.hi),
      h(
        "div",
        { class: "range" },
        h("i", { style: `left:${pct(v.lo)}%;width:${Math.max(1, pct(v.hi) - pct(v.lo))}%` }),
        h("span", { style: "left:0" }, "1"),
        h("span", { style: "right:0" }, "100")
      ),
      orderChips(v.order, c, v.turnId),
      mine
        ? h(
            "div",
            { class: "row center" },
            h("input", {
              id: "ud-input",
              type: "number",
              inputmode: "numeric",
              min: v.lo,
              max: v.hi,
              placeholder: `${v.lo}~${v.hi}`,
              class: "num-input",
              onkeydown: enterSubmit(submit),
            }),
            h("button", { class: "btn primary", onclick: submit }, "이 숫자!")
          )
        : null,
      h(
        "ul",
        { class: "history" },
        v.history
          .slice()
          .reverse()
          .map((x) =>
            h(
              "li",
              { class: x.r === "BOOM" ? "bad" : "" },
              h("b", null, c.name(x.pid)),
              ` → ${x.g} `,
              h("span", { class: `ud ${x.r}` }, x.r === "UP" ? "⬆ UP" : x.r === "DOWN" ? "⬇ DOWN" : "💥 BOOM"),
              x.auto ? h("small", { class: "muted" }, " (시간 초과)") : null
            )
          )
      )
    );
  },

  // ⚫ 오목
  omok(v, c) {
    const myTurn = v.turnId === c.me;
    const cells = [];
    for (let y = 0; y < v.size; y++) {
      for (let x = 0; x < v.size; x++) {
        const s = v.board[y * v.size + x];
        const last = v.last && v.last.x === x && v.last.y === y;
        cells.push(
          h(
            "button",
            {
              class: `cell${s ? (s === 1 ? " b" : " w") : ""}${last ? " last" : ""}${x === 0 ? " el" : ""}${x === v.size - 1 ? " er" : ""}${y === 0 ? " et" : ""}${y === v.size - 1 ? " eb" : ""}`,
              "aria-label": `${x + 1},${y + 1}`,
              disabled: !!s || !myTurn,
              onclick: () => c.act({ type: "place", x, y }),
            },
            s ? h("i") : null
          )
        );
      }
    }
    const who = (p, stone) => h("span", { class: `who${v.turnId === p.id ? " on" : ""}` }, stone, " ", p.name, p.id === c.me ? " (나)" : "");
    return h(
      "div",
      { class: "omok" },
      h("div", { class: "row center" }, who(v.black, "⚫"), h("span", { class: "muted" }, "vs"), who(v.white, "⚪")),
      turnBanner(v, c),
      h("div", { class: "board", style: `--n:${v.size}` }, cells),
      c.playing && !c.over ? h("div", { class: "row center" }, h("button", { class: "btn ghost small", onclick: () => confirm("정말 기권할까요?") && c.act({ type: "resign" }) }, "🏳 기권")) : null
    );
  },

  // ✌️ 가위바위보 서바이벌
  rps(v, c) {
    const meP = v.players.find((p) => p.id === c.me);
    const alive = meP?.alive;
    const last = v.last;
    let main;
    if (v.phase === "pick" && alive) {
      main = h(
        "div",
        { class: "hands" },
        ["scissors", "rock", "paper"].map((k) =>
          h("button", { class: `hand${v.myPick === k ? " on" : ""}`, onclick: () => c.act({ type: "pick", hand: k }) }, h("span", null, HAND[k]), h("small", null, HAND_NAME[k]))
        )
      );
    } else if (v.phase === "pick") {
      main = h("p", { class: "center muted" }, meP ? "탈락했어요. 남은 사람들을 응원해 주세요!" : "관전 중이에요");
    }
    return h(
      "div",
      { class: "rps" },
      h("div", { class: "turn" }, `${v.round}번째 판 `, v.phase === "pick" ? ["— 내세요! ", c.cd(v.remainMs)] : v.phase === "reveal" ? "— 결과" : ""),
      main,
      last
        ? h(
            "div",
            { class: `reveal${v.phase === "pick" ? " faded" : ""}` },
            h("p", { class: "reveal-title" }, `${last.round}번째 판: ${last.text}`),
            h(
              "ul",
              { class: "reveal-list" },
              Object.entries(last.picks).map(([id, k]) =>
                h("li", { class: last.out.includes(id) ? "out" : "" }, h("span", { class: "big-hand" }, HAND[k]), h("span", null, c.name(id)), last.auto.includes(id) ? h("small", { class: "muted" }, "자동") : null)
              )
            )
          )
        : null,
      h(
        "ol",
        { class: "chips" },
        v.players.map((p) => h("li", { class: `chip${p.alive ? "" : " out"}${p.id === c.me ? " me" : ""}` }, p.name, p.picked ? " ✔" : ""))
      )
    );
  },

  // ⚡ 반응속도
  reaction(v, c) {
    const key = `${v.round}`;
    if (v.phase === "go" && reactionGo.key !== key) reactionGo = { key, at: performance.now() };
    const done = v.myTime != null || v.myFalse;
    let cls = "pad",
      big,
      small = "";
    if (v.phase === "wait") {
      cls += v.myFalse ? " foul" : " wait";
      big = v.myFalse ? "너무 빨랐어요! 😅" : "기다리세요…";
      small = v.myFalse ? "이번 판은 실격" : "초록색이 되면 바로 누르세요";
    } else if (v.phase === "go") {
      cls += v.myFalse ? " foul" : done ? " done" : " go";
      big = v.myFalse ? "실격" : done ? `${v.myTime}ms` : "지금!";
      small = done ? "다른 사람을 기다리는 중…" : "";
    } else {
      cls += " done";
      const best = v.last?.best;
      big = best ? `🏅 ${c.name(best)}` : "1등 없음";
      small = best ? `${v.last.times[best]}ms` : "모두 실격!";
    }
    const tap = (e) => {
      e.preventDefault();
      if (!c.playing || done || (v.phase !== "wait" && v.phase !== "go")) return;
      const ms = v.phase === "go" ? Math.round(performance.now() - reactionGo.at) : 0;
      c.act({ type: "tap", ms });
    };
    const pad = h("button", { class: cls, onpointerdown: tap, onkeydown: (e) => (e.key === " " || e.key === "Enter") && tap(e) }, h("b", null, big), h("span", null, small));
    const times = v.last?.times || {};
    return h(
      "div",
      { class: "reaction" },
      h("div", { class: "turn" }, `${v.round} / ${v.rounds} 판`),
      c.playing ? pad : h("div", { class: cls }, h("b", null, big), h("span", null, "관전 중")),
      h(
        "table",
        { class: "score" },
        h("tr", null, h("th", null, "이름"), h("th", null, "1등"), h("th", null, "지난 판")),
        v.players
          .slice()
          .sort((a, b) => b.score - a.score)
          .map((p) =>
            h(
              "tr",
              { class: p.id === c.me ? "me" : "" },
              h("td", null, p.name, v.phase !== "reveal" && v.phase !== "done" ? (p.false ? " ❌" : p.done ? " ✔" : "") : ""),
              h("td", null, "🏅".repeat(p.score) || "-"),
              h("td", null, v.last ? (v.last.falses.includes(p.id) ? "실격" : times[p.id] != null ? `${times[p.id]}ms` : "-") : "")
            )
          )
      )
    );
  },

  // 👀 눈치 게임
  nunchi(v, c) {
    const shouted = v.mine != null;
    let main;
    if (v.phase === "ready") {
      main = h("div", { class: "pad wait" }, h("b", null, "준비…"), h("span", null, c.cd(v.remainMs), " 뒤에 시작해요"));
    } else if (!c.playing) {
      main = h("div", { class: "pad done" }, h("b", null, `${v.next}`), h("span", null, "관전 중"));
    } else {
      main = h(
        "button",
        {
          class: `pad ${shouted ? "done" : "go"}`,
          disabled: shouted || !!c.over,
          onpointerdown: (e) => {
            e.preventDefault();
            if (!shouted && !c.over) c.act({ type: "shout" });
          },
        },
        h("b", null, shouted ? `${v.mine}!` : `${v.next}!`),
        h("span", null, shouted ? "외쳤어요. 이제 지켜보세요" : "눌러서 외치기")
      );
    }
    return h(
      "div",
      { class: "nunchi" },
      h("div", { class: "turn" }, `1부터 ${v.total}까지 — 겹치지 말고, 꼴찌도 되지 말기!`),
      main,
      h("ol", { class: "claims" }, v.claims.map((x) => h("li", { class: x.clash ? "bad" : x.pid === c.me ? "me" : "" }, h("b", null, x.num), " ", x.name))),
      h(
        "p",
        { class: "muted center" },
        "아직 안 외친 사람: ",
        v.players
          .filter((p) => !p.shouted)
          .map((p) => p.name)
          .join(", ") || "없음"
      )
    );
  },

  // 🤥 라이어 게임
  liar(v, c) {
    const role =
      v.role === "liar"
        ? h("div", { class: "role liar" }, h("small", null, `주제: ${v.category}`), h("b", null, "당신은 라이어! 🤥"), h("span", null, "들키지 않게 아는 척 하세요"))
        : v.role === "citizen"
          ? h("div", { class: "role" }, h("small", null, `주제: ${v.category}`), h("b", null, v.word), h("span", null, "라이어가 눈치채지 못하게 힌트를 주세요"))
          : h("div", { class: "role" }, h("small", null, `주제: ${v.category}`), h("b", null, v.word || "???"), h("span", null, "관전 중"));

    let panel = null;
    if (v.phase === "hint") {
      const mine = v.turnId === c.me;
      const submit = () => {
        const el = document.getElementById("liar-hint");
        if (!el.value.trim()) return;
        c.act({ type: "hint", text: el.value });
        el.value = "";
      };
      panel = [
        h("div", { class: `turn${mine ? " mine" : ""}` }, v.hintRounds > 1 ? `힌트 ${v.hintRound}/${v.hintRounds}바퀴 · ` : "힌트 · ", mine ? "👉 내 차례!" : `${c.name(v.turnId)}님 차례`, " ", c.cd(v.remainMs)),
        mine
          ? h(
              "div",
              { class: "row" },
              h("input", { id: "liar-hint", maxlength: 40, placeholder: "제시어를 설명하는 한마디", class: "grow", onkeydown: enterSubmit(submit) }),
              h("button", { class: "btn primary", onclick: submit }, "보내기")
            )
          : null,
      ];
    } else if (v.phase === "vote") {
      panel = [
        h("div", { class: "turn" }, `🗳 라이어는 누구? (${v.voted.length}/${v.order.length}명 투표) `, c.cd(v.remainMs)),
        c.playing
          ? h(
              "div",
              { class: "vote-grid" },
              v.order
                .filter((p) => p.id !== c.me)
                .map((p) => h("button", { class: `btn${v.myVote === p.id ? " primary" : ""}`, onclick: () => c.act({ type: "vote", target: p.id }) }, p.name))
            )
          : null,
        h("p", { class: "muted center" }, "투표를 바꿀 수 있어요. 모두 투표하면 바로 공개!"),
      ];
    } else if (v.phase === "guess") {
      panel = [
        h("div", { class: "turn" }, `🎯 ${c.name(v.liar)}님이 라이어였어요! 제시어를 맞히면 역전! `, c.cd(v.remainMs)),
        v.role === "liar"
          ? h(
              "div",
              { class: "vote-grid" },
              v.choices.map((w) => h("button", { class: "btn", onclick: () => confirm(`'${w}' 맞나요?`) && c.act({ type: "guess", word: w }) }, w))
            )
          : h("p", { class: "center muted" }, "라이어가 제시어를 고르는 중…"),
      ];
    } else if (v.phase === "done") {
      panel = h(
        "div",
        { class: "reveal" },
        h("p", { class: "reveal-title" }, `제시어는 '${v.word}', 라이어는 ${c.name(v.liar)}님!`),
        v.tally
          ? h(
              "ul",
              { class: "reveal-list" },
              v.order.map((p) => h("li", { class: p.id === v.liar ? "out" : "" }, h("b", null, `${v.tally[p.id] || 0}표`), h("span", null, p.name)))
            )
          : null
      );
    }

    return h(
      "div",
      { class: "liar" },
      role,
      panel,
      h(
        "ul",
        { class: "hints" },
        v.hints.map((x) => h("li", { class: x.auto ? "muted" : "" }, h("b", null, c.name(x.pid)), " ", x.text))
      ),
      v.phase === "hint" ? orderChips(v.order, c, v.turnId) : null
    );
  },
};
