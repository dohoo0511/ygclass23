/*
 * 경제 균형 테스트
 *
 * 실행:  node test/economy.test.js
 *
 * index.html 의 실제 설정값과 주식 엔진을 그대로 불러와, 파이가 끝없이
 * 불어나는 구멍이 다시 생기지 않았는지 확인합니다. 저장소에는 접속하지 않습니다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

/* 브라우저 흉내 (화면은 쓰지 않고 계산 함수만 꺼내 씀) */
const stub = () => ({ addEventListener(){}, style:{}, classList:{add(){},remove(){},contains:()=>false},
    textContent:'', innerHTML:'', value:'', disabled:false, appendChild(){}, remove(){}, querySelectorAll:()=>[], children:[] });
global.document = { getElementById: stub, createElement: stub, addEventListener(){}, body: stub(), querySelectorAll: () => [], visibilityState: 'visible' };
global.window = { addEventListener(){}, innerWidth: 400 };
global.location = { protocol: 'https:', hostname: 'x.pages.dev' };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.alert = () => {}; global.confirm = () => true;
global.fetch = async () => { throw new Error('no net'); };
global.setInterval = () => 0; global.setTimeout = () => 0;

const app = {};
eval(script + `
  app.initStock = initStockMarket; app.applyTicks = applyStockTicks; app.setDb = v => { db = v; };
  app.COMPANIES = COMPANIES; app.holdingOf = holdingOf; app.buyableQty = buyableQty;
  app.totalHeldQty = totalHeldQty; app.savingsPayout = savingsPayout; app.savingsRatePct = savingsRatePct;
  app.migSize = migrateStockTickSize; app.series = stockSeries; app.scale = chartScale;
  app.wipe = resetStockHistoryOnce; app.HVER = STOCK_HISTORY_VERSION;
  app.K = { MIN: STOCK_MIN_PRICE, LOCK: STOCK_BUY_LOCK_PRICE, PER: STOCK_MAX_HOLD_PER_COMPANY,
            TOTAL: STOCK_MAX_HOLD_TOTAL, ORDER: STOCK_MAX_ORDER, DIV: DIVIDEND_RATE_PCT,
            LOTTO_MAX: LOTTO_NUMBER_MAX, TERMS: SAVINGS_TERM_WEEKS, TICK: STOCK_TICK_MS,
            HIST: STOCK_HISTORY_TICKS, MAG: NEWS_MAGNITUDES };
`);

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const DAY = 24 * 3600 * 1000;
const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };

/* ── 적금: 기간이 길어져도 수익률이 폭주하지 않아야 함 ── */
const yields = app.K.TERMS.map(w => app.savingsPayout({ principal: 100, weeks: w, weeklyRatePct: app.savingsRatePct(w) }) / 100 - 1);
check('8주 적금 수익률이 30% 미만 (예전 160%)', yields[yields.length - 1] < 0.30);
check('적금 이율이 기간에 비례해 커지지 않음 (제곱 증가 없음)',
    app.savingsRatePct(2) === app.savingsRatePct(8));
check('그래도 기간이 길수록 이득', yields[yields.length - 1] > yields[0]);

/* ── 로또 ──
   drawLotto 의 실제 분배: 누적 상금(Pot)의 40% 는 1등, 30% 는 2등.
   당첨자가 없는 몫만 다음 회차로 이월되고, 나머지 30% 는 지급도 이월도 되지 않고 사라진다.
   그래서 로또는 파이를 만드는 쪽이 아니라 없애는 쪽이어야 정상이다.
   (한때 "회수율 125%" 로 잘못 계산했는데, Pot 의 70% 가 매번 돌아온다고 본 탓이었다) */
const N = app.K.LOTTO_MAX, T = C(N, 5), p = m => C(5, m) * C(N - 5, 5 - m) / T;
const TICKETS = 300;                              // 학생 30명이 주 10장씩 산다고 보고
const revenue = TICKETS * 4;
const noneOf = m => Math.pow(1 - p(m), TICKETS);  // 그 등수 당첨자가 한 명도 없을 확률
const rollFrac = 0.4 * noneOf(5) + 0.3 * noneOf(4);
const pot = revenue / (1 - rollFrac);             // 이월이 쌓이다 멈추는 지점
const paidCash = 0.4 * pot * (1 - noneOf(5)) + 0.3 * pot * (1 - noneOf(4))
    + TICKETS * (p(5) * 22 + p(4) * 13);          // 기본 상금은 Pot 과 별개로 지급
const netCash = paidCash - revenue;
const coupons = TICKETS * (p(3) + p(2));          // 3·4등으로 공짜로 풀리는 쿠폰

check(`로또가 파이를 늘리지 않음 — 주 ${netCash.toFixed(0)}π`, netCash <= 0);
check(`누적 상금이 끝없이 불어나지 않음 — ${pot.toFixed(0)}π 에서 멈춤`, pot < 10000);
check(`쿠폰 살포가 주 100장 미만 — ${coupons.toFixed(0)}장 (상점 수요를 죽이지 않을 것)`, coupons < 100);

/* ── 주식 보유 한도 ── */
const user = { pi: 100000, stocks: {} };
check('처음엔 전체 한도만큼 살 수 있음', app.buyableQty(user, 'taehoon') === app.K.TOTAL);
user.stocks.taehoon = [{ q: app.K.PER, cost: 100, at: 0, paid: 0 }];
check('한 회사를 한도까지 채우면 그 회사는 더 못 삼', app.buyableQty(user, 'taehoon') === 0);
check('전체 한도도 함께 걸림', app.buyableQty(user, 'ttaek') === Math.max(0, app.K.TOTAL - app.K.PER));
user.stocks.taehoon = [{ q: 3, cost: 30, at: 0, paid: 0 }];
user.stocks.ttaek = [{ q: 4, cost: 40, at: 0, paid: 0 }];
check('여러 회사에 나눠 가져도 합계로 계산', app.totalHeldQty(user) === 7);
check('남은 만큼만 더 살 수 있음', app.buyableQty(user, 'dohoo') === app.K.TOTAL - 7);
check('1회 주문 한도가 보유 한도를 넘지 않음', app.K.ORDER <= app.K.TOTAL);

/* ── 최저가에서 사는 것을 막는 설정이 살아 있는가 ── */
check('최저가 매수 잠금값이 최저가 이상', app.K.LOCK >= app.K.MIN);

/* ── 배당: 손실 없는 수입이라 낮아야 함 ── */
check(`배당률 1% 이하 — 현재 ${app.K.DIV}%`, app.K.DIV <= 1);
const held = app.K.TOTAL, price = 16;
const weekly = Math.round(price * app.K.DIV / 100 * held) / 2;
check(`학생 1명이 한도까지 들고 있어도 배당은 주 ${weekly.toFixed(1)}π 이하`, weekly <= 1);

/* ── 급등락이 드물어야 함 ── */
const magPct = app.K.MAG.map((m, i) => m.chance - (i ? app.K.MAG[i - 1].chance : 0));
check(`대부분의 뉴스는 주가를 움직이지 않음 — ${(magPct[0] * 100).toFixed(0)}%`, magPct[0] >= 0.7);
// 1시간마다 24건이 나오므로, 그 중 실제로 움직이는 건수가 하루 2~6번쯤이어야 그래프가 보기 좋다
const movesPerDay = (24 * 3600 * 1000 / app.K.TICK) * (1 - magPct[0]);
check(`하루에 주가가 움직이는 횟수가 2~6번 — ${movesPerDay.toFixed(1)}번`, movesPerDay >= 2 && movesPerDay <= 6);
const bigMoves = magPct[3] + magPct[4];
check(`큰 폭 이상 뉴스가 2% 미만 — ${(bigMoves * 100).toFixed(1)}%`, bigMoves < 0.02);

/* ── 뉴스 흐름: 며칠씩 이어지고, 하루 변동은 크지 않아야 함 ── */
let runLen = 0, eff = 0, effN = 0, swingPct = 0, n2 = 0;
const endRatios = [];
for (let r = 0; r < 20; r++) {
    const t0 = Date.UTC(2026, 0, 5);
    const d = { users: {}, stocks: null };
    app.setDb(d);
    d.stocks = app.initStock(t0);
    d.stocks.seed += r * 7919;
    const series = {};
    app.COMPANIES.forEach(c => series[c.id] = []);
    for (let k = 1; k <= 60; k++) {
        app.applyTicks(t0 + k * DAY);
        app.COMPANIES.forEach(c => series[c.id].push(d.stocks.companies[c.id].price));
    }
    app.COMPANIES.forEach(c => {
        const v = series[c.id];
        endRatios.push(v[v.length - 1] / c.startPrice);
        const dif = v.slice(1).map((x, i) => x - v[i]);
        const signs = dif.map(Math.sign).filter(x => x);
        let runs = 1;
        for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) runs++;
        runLen += signs.length / runs;
        // 추세 효율: 7일 동안 실제로 이동한 거리 / 그 사이 오르내린 총 거리
        for (let i = 0; i + 7 < v.length; i++) {
            let gross = 0;
            for (let j = i; j < i + 7; j++) gross += Math.abs(v[j + 1] - v[j]);
            if (gross > 0) { eff += Math.abs(v[i + 7] - v[i]) / gross; effN++; }
        }
        const avgPrice = v.reduce((s2, x) => s2 + x, 0) / v.length;
        swingPct += dif.reduce((s2, x) => s2 + Math.abs(x), 0) / dif.length / avgPrice * 100;
        n2++;
    });
}
endRatios.sort((a, b) => a - b);
const drift = endRatios[Math.floor(endRatios.length / 2)] - 1;   // 중앙값
check(`뉴스만으로는 주가가 한쪽으로 쏠리지 않음 (60일 중앙값 ${(drift * 100).toFixed(1)}%)`, Math.abs(drift) < 0.25);
// 기준값은 수정 전 코드를 같은 방법으로 돌려서 잰 값이다 (연속 1.45일, 추세효율 0.151, 일변동 27.0%).
// 넉넉히 잡되, 예전 수준으로 되돌아가면 반드시 걸리도록 둔다
check(`흐름이 예전보다 오래 이어짐 — ${(runLen / n2).toFixed(2)}일 (예전 1.45일)`, runLen / n2 > 1.55);
check(`흐름이 톱니가 아니라 한 방향으로 감 — 추세 효율 ${(eff / effN).toFixed(3)} (예전 0.151)`, eff / effN > 0.18);
check(`하루 변동이 예전보다 작음 — ${(swingPct / n2).toFixed(1)}% (예전 27.0%)`, swingPct / n2 < 22);

/* ── 뉴스 간격을 바꿔도 예전 데이터가 멈추지 않아야 함 ── */
const OLD_MS = 30 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 17, 3, 0);
const legacyTick = Math.floor(NOW / OLD_MS);
const legacy = {
    seed: 20260915, eventCount: 500, marketMood: 0,
    lastTick: legacyTick, historyStartTick: legacyTick - 335,
    companies: {}, contracts: [], contractProjects: {}, trades: [],
    flow: { week: 0, buy: {}, sell: {} }, news: []
};
app.COMPANIES.forEach((c, i) => {
    legacy.companies[c.id] = { price: c.startPrice + i, anchor: c.startPrice, mood: 0,
        history: Array.from({ length: 336 }, (_, k) => c.startPrice + (k % 5)) };
});
const kept = app.COMPANIES.map(c => legacy.companies[c.id].price);
check('예전(30분) 데이터를 새 간격으로 옮김', app.migSize(legacy) === true);
const nowTick = Math.floor(NOW / app.K.TICK);
check('옮긴 뒤 회차가 현재를 넘지 않음 → 뉴스가 다시 나옴', legacy.lastTick <= nowTick);
check('옮겨도 주가는 그대로', app.COMPANIES.every((c, i) => legacy.companies[c.id].price === kept[i]));
const hlen = legacy.companies[app.COMPANIES[0].id].history.length;
check('그래프 시간축이 어긋나지 않음', legacy.historyStartTick + hlen - 1 === legacy.lastTick);
check('그래프가 보관 한도 안에 들어옴', hlen <= app.K.HIST);
check('두 번 옮기지 않음', app.migSize(legacy) === false);
app.setDb({ users: {}, stocks: legacy });
const beforeTick = legacy.lastTick;
check('옮긴 뒤 뉴스가 실제로 진행됨', app.applyTicks(NOW + 5 * app.K.TICK) === true && legacy.lastTick > beforeTick);

/* ── 그래프 시간축 ──
   그래프는 '배열의 칸 하나 = 뉴스 1회차' 로 보고 x축을 그린다.
   간격이 바뀔 때 값을 옮기지 않으면 30일치가 7일 자리에 밀려 들어가 그래프가 찌그러진다. */
const HOUR = 3600 * 1000, DAY_MS = 24 * HOUR;
function makeMarket(prevMs, histLen, now) {
    const lastTick = Math.floor(now / prevMs);
    const companies = {};
    app.COMPANIES.forEach((c, i) => {
        companies[c.id] = { price: c.startPrice + i, anchor: c.startPrice, mood: 0, trend: 0,
            history: Array.from({ length: histLen }, (_, k) => 10 + (k % 7)) };
    });
    const st = { seed: 20260915, eventCount: 100, marketMood: 0, lastTick,
        historyStartTick: lastTick - (histLen - 1), companies, contracts: [], contractProjects: {},
        trades: [], flow: { week: 0, buy: {}, sell: {} }, news: [] };
    if (prevMs !== 30 * 60 * 1000) st.tickMs = prevMs;   // 예전 30분 데이터에는 tickMs 가 없다
    return st;
}
const REAL_NOW = Date.now();
[['30분 데이터 336칸', 30 * 60 * 1000, 336],
 ['4시간 데이터 42칸', 4 * HOUR, 42],
 ['4시간 데이터 180칸', 4 * HOUR, 180],
 ['간격을 여러 번 바꾼 뒤', 2 * HOUR, 90]].forEach(([name, prevMs, len]) => {
    const st = makeMarket(prevMs, len, REAL_NOW);
    const priceBefore = st.companies[app.COMPANIES[0].id].price;
    app.setDb({ users: {}, stocks: st });
    check(`${name} → 옮김이 일어남`, app.migSize(st) === true);
    const h = st.companies[app.COMPANIES[0].id].history;
    // 간격이 바뀌면 예전 값이 어느 시각의 것인지 알 수 없다. 뒤섞인 값을 남기느니 새로 시작한다
    check(`${name} → 그래프 기록을 지금 가격으로 새로 시작`, h.length === 1 && h[0] === priceBefore);
    check(`${name} → 시간축이 현재 회차와 맞음`, st.historyStartTick === st.lastTick);
    check(`${name} → 주가는 그대로`, st.companies[app.COMPANIES[0].id].price === priceBefore);
});

/* ── 화면에서 본 것과 같은, 값이 뒤섞인 기록을 털어내는지 ──
   세로축이 5~27 로 잡혔다는 건 기록에 5 와 21 이 함께 들어 있다는 뜻이었다.
   지금 주가(15)와 맞지 않는 옛 값이 왼쪽에 남아 나머지를 눌러 평평하게 만들었다. */
{
    const broken = makeMarket(app.K.TICK, 24, REAL_NOW);
    broken.tickMs = app.K.TICK;                       // 간격은 이미 맞은 상태 = 간격 옮김으로는 안 지워짐
    const cid = app.COMPANIES[0].id;
    broken.companies[cid].price = 15;
    broken.companies[cid].history = [5, 21, ...Array(22).fill(15)];   // 화면과 같은 모양
    const before = app.scale(broken.companies[cid].history);
    check(`고장난 기록이면 세로축이 크게 벌어짐 — ${before.lo}~${before.hi}π (화면과 같음)`,
        before.hi - before.lo >= 20);

    app.setDb({ users: {}, stocks: broken });
    check('간격 옮김만으로는 안 지워짐', app.migSize(broken) === false);
    check('기록 비우기가 한 번 일어남', app.wipe(broken) === true);
    check('기록이 지금 가격 하나로 새로 시작', broken.companies[cid].history.length === 1
        && broken.companies[cid].history[0] === 15);
    check('시간축이 현재 회차와 맞음', broken.historyStartTick === broken.lastTick);
    check('주가는 그대로', broken.companies[cid].price === 15);
    check('두 번은 비우지 않음', app.wipe(broken) === false);

    // 비운 뒤 하루 돌리면 정상적인 24시간 그래프가 나오는지
    for (let h2 = 1; h2 <= 26; h2++) app.applyTicks(REAL_NOW + h2 * HOUR);
    const last24 = broken.companies[cid].history.slice(-24);
    const after = app.scale(last24);
    const used = (Math.max(...last24) - Math.min(...last24)) / (after.hi - after.lo) * 100;
    check(`비운 뒤 하루 만에 세로축이 좁아짐 — ${after.lo}~${after.hi}π`, after.hi - after.lo < 20);
    check(`비운 뒤 선이 화면 높이를 씀 — ${used.toFixed(0)}%`, used >= 30);
}

// 간격이 그대로면 기록을 건드리지 않아야 함
const keepSt = makeMarket(app.K.TICK, 100, REAL_NOW);
app.setDb({ users: {}, stocks: keepSt });
check('간격이 그대로면 기록을 건드리지 않음',
    app.migSize(keepSt) === false && keepSt.companies[app.COMPANIES[0].id].history.length === 100);

// 새로 시작한 뒤 하루 돌리면 24시간 그래프가 다시 채워지는지
const chartSt = makeMarket(30 * 60 * 1000, 336, REAL_NOW);
app.setDb({ users: {}, stocks: chartSt });
app.migSize(chartSt);
for (let h2 = 1; h2 <= 26; h2++) app.applyTicks(REAL_NOW + h2 * HOUR);
const pts = app.series(app.COMPANIES[0].id, 24);
check(`새로 시작한 뒤 하루 만에 점 20개 이상 — ${pts.length}개`, pts.length >= 20);
check('그래프 마지막 점이 지금 가격', pts[pts.length - 1].live === true);
check('시간축이 계속 맞음',
    chartSt.historyStartTick + chartSt.companies[app.COMPANIES[0].id].history.length - 1 === chartSt.lastTick);

/* ── 세로축 ──
   주가가 11~18π 라 1π 만 움직여도 큰 변화인데, 세로축 높이를 무조건 10π 이상 잡으면
   (여백까지 붙어 15~20π) 그 움직임이 화면 높이의 5% 밖에 안 돼서 일자로 보인다.
   선이 화면 높이를 충분히 쓰는지 검사한다. */
function heightUsed(prices) {
    const { lo, hi } = app.scale(prices);
    return (Math.max(...prices) - Math.min(...prices)) / (hi - lo) * 100;
}
check(`1π 움직임이 화면 높이의 15% 이상 — ${heightUsed([14, 15, 14, 15]).toFixed(0)}%`, heightUsed([14, 15, 14, 15]) >= 15);
check(`2π 움직임이 화면 높이의 30% 이상 — ${heightUsed([13, 14, 15, 14]).toFixed(0)}%`, heightUsed([13, 14, 15, 14]) >= 30);
check(`4π 움직임이 화면 높이의 40% 이상 — ${heightUsed([11, 13, 15, 12]).toFixed(0)}%`, heightUsed([11, 13, 15, 12]) >= 40);
check(`큰 움직임도 넘치지 않음 — ${heightUsed([10, 18, 12, 22]).toFixed(0)}%`, heightUsed([10, 18, 12, 22]) <= 85);

/* ── 실제 엔진이 만든 값으로 그래프를 그려 본다 (설명이 아니라 결과로 확인) ── */
{
    const HOUR_MS2 = 3600 * 1000;
    let usedSum = 0, distinctSum = 0, cnt = 0, flatCharts = 0;
    for (let r = 0; r < 8; r++) {
        const t0 = Date.UTC(2026, 0, 5);
        const d = { users: {}, stocks: null };
        app.setDb(d);
        d.stocks = app.initStock(t0);
        d.stocks.seed += r * 7919;
        for (let h = 1; h <= 7 * 24; h++) app.applyTicks(t0 + h * HOUR_MS2);
        app.COMPANIES.forEach(c => {
            const last24 = d.stocks.companies[c.id].history.slice(-24);
            const { lo, hi } = app.scale(last24);
            const used = (Math.max(...last24) - Math.min(...last24)) / (hi - lo) * 100;
            const distinct = new Set(last24).size;
            usedSum += used; distinctSum += distinct; cnt++;
            if (used < 20) flatCharts++;
        });
    }
    check(`24시간 그래프가 화면 높이를 충분히 씀 — 평균 ${(usedSum / cnt).toFixed(0)}%`, usedSum / cnt >= 40);
    check(`24시간 안에 서로 다른 값이 여러 개 — 평균 ${(distinctSum / cnt).toFixed(1)}개`, distinctSum / cnt >= 3);
    check(`일자로 보이는 그래프가 거의 없음 — ${flatCharts}/${cnt}개`, flatCharts <= cnt * 0.1);
}

[[15, 15, 15], [14, 15], [5, 5, 5], [5, 6, 7], [198, 200], [11, 13, 15, 12]].forEach(ps => {
    const { lo, hi } = app.scale(ps);
    check(`세로축이 늘 올바름 [${ps.join(',')}] → ${lo}~${hi}π`,
        hi > lo && lo <= Math.min(...ps) && hi >= Math.max(...ps)
        && lo >= app.K.MIN && hi <= 200 && (hi - lo) % 2 === 0);
});

console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
const failed = results.filter(x => !x[1]).length;
console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
process.exit(failed === 0 ? 0 : 1);
