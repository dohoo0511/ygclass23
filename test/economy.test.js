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
  app.initStock = initStockMarket; app.applyTicks = applyStockTicks; app.tickTo = applyStockTicks; app.setDb = v => { db = v; };
  app.COMPANIES = COMPANIES; app.holdingOf = holdingOf; app.buyableQty = buyableQty;
  app.totalHeldQty = totalHeldQty; app.savingsPayout = savingsPayout; app.savingsRatePct = savingsRatePct;
  app.migSize = migrateStockTickSize; app.series = stockSeries; app.scale = chartScale;
  app.wipe = resetStockHistoryOnce; app.HVER = STOCK_HISTORY_VERSION; app.event = runStockEvent;
  app.COUPONS = COUPONS; app.basePrice = couponBasePrice; app.priceFor = couponPriceFor;
  app.clamp = clampStockTick; app.push = pushStockHistory; app.nextNews = minutesToNextNews;
  app.migrate = migrateData; app.GRADES = GRADES; app.PRICE_MAX = COUPON_PRICE_MAX;
  app.LOAN_PCT = LOAN_WEEKLY_INTEREST_PCT; app.SAVE_PCT = SAVINGS_WEEKLY_RATE_PCT;
  app.getDbCouponPrices = () => db.couponPrices;
  app.timeTick = applyTimeBasedUpdates; app.savingsPayoutOf = savingsPayout;
  app.OVERDUE = LOAN_OVERDUE_EXP_PENALTY;
  app.REASONS = NEWS_REASONS;
  app.matchCount = lottoMatchCount; app.ticketNums = ticketNumbers; app.ticketBonus = ticketBonus;
  app.ticketKey = ticketKey; app.HIDDEN = HIDDEN_REWARD;
  app.boxOdds = boxOdds; app.boxValue = boxRewardValue; app.byPrice = couponsByPrice;
  app.BOX = { PRICE: RANDOM_BOX_PRICE, MIN: BOX_PRIZE_MIN_SHARE, MAX: BOX_PRIZE_MAX_SHARE,
              HID_CH: HIDDEN_REWARD_CHANCE, HID: HIDDEN_REWARD };
  app.CONTRACT = { MIN_TICKS: CONTRACT_MIN_TICKS, MAX: CONTRACT_MAX,
                   COOLDOWN: CONTRACT_COOLDOWN_TICKS, END_CHANCE: CONTRACT_END_CHANCE };
  app.K = { MIN: STOCK_MIN_PRICE, LOCK: STOCK_BUY_LOCK_PRICE, PER: STOCK_MAX_HOLD_PER_COMPANY,
            TOTAL: STOCK_MAX_HOLD_TOTAL, ORDER: STOCK_MAX_ORDER, DIV: DIVIDEND_RATE_PCT,
            LOTTO_MAX: LOTTO_NUMBER_MAX, LOTTO_BONUS: LOTTO_BONUS_MAX, TERMS: SAVINGS_TERM_WEEKS, TICK: STOCK_TICK_MS,
            HIST: STOCK_HISTORY_TICKS, MAG: NEWS_MAGNITUDES };
`);

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const DAY = 24 * 3600 * 1000;
const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };

/* ── 적금: 기간이 길어져도 수익률이 폭주하지 않아야 함 ── */
const yields = app.K.TERMS.map(w => app.savingsPayout({ principal: 100, weeks: w, weeklyRatePct: app.savingsRatePct(w) }) / 100 - 1);
// 예전에는 이율 자체가 기간에 비례해 커지고 만기 계산에서 주수를 또 곱해서
// 8주 적금이 +160% 였다. 그게 물가가 오르던 원인 중 하나였다.
// 지금은 주 5% 고정(8주 +40%). 60% 를 넘으면 그 제곱 증가가 돌아온 것으로 본다
check(`8주 적금 수익률 — ${(yields[yields.length - 1] * 100).toFixed(0)}% (예전 160%)`,
    yields[yields.length - 1] < 0.60);
check('적금 이율이 기간에 비례해 커지지 않음 (제곱 증가 없음)',
    app.savingsRatePct(2) === app.savingsRatePct(8));
check('그래도 기간이 길수록 이득', yields[yields.length - 1] > yields[0]);
// 적금 이자가 대출 이자보다 높으면, 빌려서 적금에 넣는 것만으로 파이가 생긴다
check(`적금 이자(주 ${app.SAVE_PCT}%)가 대출 이자(주 ${app.LOAN_PCT}%)보다 낮음`,
    app.SAVE_PCT < app.LOAN_PCT);
{
    // 실제 금액으로도 확인: 100π 를 2주 빌려 적금에 넣으면 손해여야 한다
    const weeks = 2, principal = 100;
    const loanCost = principal * app.LOAN_PCT * weeks / 100;
    const saveGain = app.savingsPayout({ principal, weeks, weeklyRatePct: app.savingsRatePct(weeks) }) - principal;
    check(`빌려서 적금에 넣으면 손해 — 이자 ${loanCost}π vs 수익 ${saveGain}π`, saveGain < loanCost);
}

/* ── 로또 ──
   drawLotto 의 실제 분배: 누적 상금(Pot)의 40% 는 1등, 30% 는 2등.
   당첨자가 없는 몫만 다음 회차로 이월되고, 나머지 30% 는 지급도 이월도 되지 않고 사라진다.
   그래서 로또는 파이를 만드는 쪽이 아니라 없애는 쪽이어야 정상이다.
   (한때 "회수율 125%" 로 잘못 계산했는데, Pot 의 70% 가 매번 돌아온다고 본 탓이었다) */
const N = app.K.LOTTO_MAX, T = C(N, 5);
const pMain = m => (m < 0 || m > 5) ? 0 : C(5, m) * C(N - 5, 5 - m) / T;
// 보너스 번호(1~10) 가 맞으면 맞힌 개수가 1 늘어난다. 그래서 등수는 '합계' 로 매긴다
const pB = 1 / app.K.LOTTO_BONUS;
const p = t => pMain(t) * (1 - pB) + pMain(t - 1) * pB;
const p1st = p(5) + p(6);                         // 5개 이상이면 모두 1등
const TICKETS = 300;                              // 학생 30명이 주 10장씩 산다고 보고
const revenue = TICKETS * 4;
const noneOf = prob => Math.pow(1 - prob, TICKETS);
const rollFrac = 0.4 * noneOf(p1st) + 0.3 * noneOf(p(4));
const pot = revenue / (1 - rollFrac);             // 이월이 쌓이다 멈추는 지점
const paidCash = 0.4 * pot * (1 - noneOf(p1st)) + 0.3 * pot * (1 - noneOf(p(4)))
    + TICKETS * (p1st * 22 + p(4) * 13);          // 기본 상금은 Pot 과 별개로 지급
const netCash = paidCash - revenue;
const coupons = TICKETS * (p(3) + p(2));          // 3·4등으로 공짜로 풀리는 쿠폰

check(`로또가 파이를 늘리지 않음 — 주 ${netCash.toFixed(0)}π`, netCash <= 0);
check(`누적 상금이 끝없이 불어나지 않음 — ${pot.toFixed(0)}π 에서 멈춤`, pot < 10000);
// 보너스를 넣으면서 당첨이 쉬워졌다. 쿠폰이 너무 쏟아지면 상점에서 살 이유가 없어진다
check(`쿠폰 살포가 주 100장 미만 — ${coupons.toFixed(0)}장 (보너스 넣기 전 75장)`, coupons < 100);
// 보너스를 넣은 이유: 1등이 거의 안 나왔다
check(`1등이 너무 어렵지 않음 — ${(p1st * 100).toFixed(4)}% (보너스 넣기 전 0.0019%)`, p1st > pMain(5) * 5);
check(`그래도 1등은 귀함 — 주 ${(TICKETS * p1st).toFixed(2)}명`, TICKETS * p1st < 1);

/* ── 티켓 읽기: 예전 티켓(숫자 배열)도 그대로 쓸 수 있어야 함 ── */
{
    const win = [1, 2, 3, 4, 5], winBonus = 7;
    check('새 티켓: 번호 3개 + 보너스 맞음 = 4개',
        app.matchCount({ n: [1, 2, 3, 20, 21], b: 7 }, win, winBonus) === 4);
    check('새 티켓: 보너스가 틀리면 그대로',
        app.matchCount({ n: [1, 2, 3, 20, 21], b: 9 }, win, winBonus) === 3);
    check('새 티켓: 5개 + 보너스 = 6개',
        app.matchCount({ n: [1, 2, 3, 4, 5], b: 7 }, win, winBonus) === 6);
    check('예전 티켓(배열)도 계산됨 — 보너스는 없는 것으로',
        app.matchCount([1, 2, 3, 20, 21], win, winBonus) === 3);
    check('보너스 번호는 본번호와 따로 셈 (같은 숫자여도 두 번 안 셈)',
        app.matchCount({ n: [1, 2, 3, 20, 21], b: 1 }, win, winBonus) === 3);
    check('티켓 구분값이 보너스까지 봄',
        app.ticketKey({ n: [1, 2, 3, 4, 5], b: 1 }) !== app.ticketKey({ n: [1, 2, 3, 4, 5], b: 2 }));
    check('예전 티켓에서도 번호를 꺼낼 수 있음',
        app.ticketNums([3, 9]).length === 2 && app.ticketBonus([3, 9]) === null);
}

/* ── 쿠폰 가격을 관리자가 바꿀 수 있어야 함 ── */
{
    const coupon = app.COUPONS.find(c => c.name === '청소 면제권');
    const emeraldExp = app.GRADES[app.GRADES.length - 1].minExp;
    const setDb = prices => app.setDb({
        users: { '1': { exp: 0, pi: 999 }, '2': { exp: emeraldExp, pi: 999 } },
        couponPrices: prices, stocks: null
    });

    setDb({});
    check(`바꾼 적 없으면 처음 가격 — ${app.basePrice(coupon)}π`, app.basePrice(coupon) === coupon.price);

    setDb({ '청소 면제권': 25 });
    check('관리자가 바꾼 가격이 우선', app.basePrice(coupon) === 25);
    check('브론즈 학생은 그 가격 그대로', app.priceFor('1', coupon) === 25);
    check('에메랄드 할인은 바뀐 가격에서 빠짐 — 25 - 2 = 23', app.priceFor('2', coupon) === 23);

    setDb({ '청소 면제권': 0 });
    check('0π 로 두면 공짜', app.basePrice(coupon) === 0 && app.priceFor('1', coupon) === 0);
    check('할인 때문에 음수가 되지 않음', app.priceFor('2', coupon) === 0);

    setDb({ '청소 면제권': 1 });
    check('할인이 가격보다 커도 0 밑으로 안 감', app.priceFor('2', coupon) === 0);

    // 잘못된 값이 저장돼 있어도 처음 가격으로 버텨야 함
    [-5, 1.5, '20', null, undefined, NaN].forEach(bad => {
        setDb({ '청소 면제권': bad });
        check(`이상한 값(${String(bad)})이면 처음 가격으로 — ${app.basePrice(coupon)}π`, app.basePrice(coupon) === coupon.price);
    });

    // 바꾼 쿠폰만 영향받아야 함
    setDb({ '청소 면제권': 25 });
    const other = app.COUPONS.find(c => c.name === '간식 교환권');
    check('바꾸지 않은 쿠폰은 그대로', app.basePrice(other) === other.price);

    // 저장 자리가 없던 예전 데이터도 안전해야 함
    app.setDb({ users: { '1': { exp: 0, pi: 1 } }, lotto: {}, bank: {}, usageRequests: [], notice: '' });
    check('couponPrices 가 없는 예전 데이터도 처음 가격', app.basePrice(coupon) === coupon.price);
    app.migrate();
    check('이전 처리가 저장 자리를 만들어 둠', typeof app.getDbCouponPrices() === 'object');

    check('가격 상한이 정해져 있음', Number.isInteger(app.PRICE_MAX) && app.PRICE_MAX > 0);
}

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
// 움직이지 않는 뉴스가 너무 많으면 주식이 멈춘 것처럼 보인다.
// 70% 였을 때 실제로 그랬다: 한 회사가 시간의 64% 를 그대로 있었고 길게는 13시간 연속이었다.
// 70% → 50% → 35% 로 두 번 낮췄다 (교실에서 계속 '멈춰 보인다' 는 말이 나와서).
// 그렇다고 0 에 가까우면 매시간 출렁여서 흐름이 안 보인다. 그 사이를 지킨다
check(`움직이지 않는 뉴스가 30~50% — ${(magPct[0] * 100).toFixed(0)}%`, magPct[0] >= 0.3 && magPct[0] <= 0.5);
// 1시간마다 24건이 나온다. 하루 10~16번은 움직여야 '멈춘 것 같다' 는 말이 안 나온다
// (예전 목표는 5~10번이었는데, 교실에서 써 보니 그 정도로는 멈춘 것처럼 보였다)
const movesPerDay = (24 * 3600 * 1000 / app.K.TICK) * (1 - magPct[0]);
check(`하루에 주가가 움직이는 횟수가 10~16번 — ${movesPerDay.toFixed(1)}번`, movesPerDay >= 10 && movesPerDay <= 16);
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
// 여러 번 재 본 결과, 흐름(며칠 이어지는 추세)과 '그래프가 움직여 보이는 것' 은 함께 얻을 수 없다.
// 주가가 11~18π 라 1π 만 움직여도 7% 여서, 자주 움직이면 그 소음이 흐름을 덮는다.
//
// 교실에서 '계속 변동 없음' 이라는 말이 나와서, 움직이지 않는 뉴스를 70% → 50% 로 낮췄다.
// 그 대가로 흐름이 1.45일 → 1.38일, 하루 변동이 27% → 30% 로 조금 나빠졌다.
// 멈춰 보이는 것이 더 큰 문제라 이 교환을 택했고, 여기서 더 나빠지지는 않게 지킨다.
// 둘 다 얻으려면 주가 자릿수를 키워야 한다(예: 15π → 60π. 그러면 1π 가 1.7% 가 되어
// 자주 움직여도 흐름이 안 묻힌다. 학생 보유 주식·배당·한도까지 함께 손봐야 하는 별도 작업).
check(`흐름이 지금 수준을 지킴 — ${(runLen / n2).toFixed(2)}일 (교환 전 1.45일)`, runLen / n2 >= 1.30);
check(`흐름이 톱니로 무너지지 않음 — 추세 효율 ${(eff / effN).toFixed(3)} (예전 0.151)`, eff / effN >= 0.13);
check(`하루 변동이 지금 수준을 지킴 — ${(swingPct / n2).toFixed(1)}% (교환 전 27.0%)`, swingPct / n2 <= 32);

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

/* ── 관리자가 직접 낸 뉴스는 반드시 주가를 움직여야 함 ──
   평소 뉴스는 절반쯤이 주가를 안 움직인다. 관리자가 일부러 누른 것까지
   그러면 '눌렀는데 아무 일도 안 일어난다' 가 된다 (실제로 그런 신고를 받았다) */
{
    const t0 = Date.UTC(2026, 0, 5);
    const cid = app.COMPANIES[0].id;
    let normalMoved = 0, forcedMoved = 0;
    const N = 200;
    for (let r = 0; r < N; r++) {
        for (const forced of [false, true]) {
            const d = { users: {}, stocks: null };
            app.setDb(d);
            d.stocks = app.initStock(t0);
            d.stocks.seed += r * 7919;
            const before = d.stocks.companies[cid].price;
            app.event(t0, cid, true, forced);
            if (d.stocks.companies[cid].price !== before) { forced ? forcedMoved++ : normalMoved++; }
        }
    }
    // 중요한 건 '평소보다 확실히 잘 움직인다' 는 대비다 (평소는 절반쯤, 강제는 언제나)
    check(`평소 뉴스는 절반쯤만 주가를 움직임 — ${(normalMoved / N * 100).toFixed(0)}%`, normalMoved / N < 0.7);
    check(`관리자가 낸 뉴스는 반드시 움직임 — ${(forcedMoved / N * 100).toFixed(0)}%`, forcedMoved === N);
}

/* ── 관리자 '뉴스 추가' 가 그래프에도 점을 찍는지 ──
   점은 '회차 하나에 하나' 라서, 점을 찍으려면 회차도 함께 앞당겨야 한다.
   그래야 historyStartTick + 길이 - 1 === lastTick 관계가 깨지지 않는다 */
{
    const now = Date.now();
    const d = { users: {}, stocks: null };
    app.setDb(d);
    d.stocks = app.initStock(now);
    const cid = app.COMPANIES[0].id;
    const axisOk = () => d.stocks.historyStartTick + d.stocks.companies[cid].history.length - 1 === d.stocks.lastTick;

    check('시작할 때 시간축이 맞음', axisOk());
    const before = { len: d.stocks.companies[cid].history.length, tick: d.stocks.lastTick, price: d.stocks.companies[cid].price };

    // adminForceNews 가 하는 일과 같은 순서
    const pressForceNews = () => {
        app.COMPANIES.forEach(c => app.event(Date.now(), c.id, true, true));
        d.stocks.lastTick += 1;
        app.push();
    };

    pressForceNews();
    check('한 번 누르면 점이 정확히 하나 늘어남', d.stocks.companies[cid].history.length === before.len + 1);
    check('회차도 한 칸 앞당겨짐', d.stocks.lastTick === before.tick + 1);
    check('시간축이 그대로 맞음', axisOk());
    check('주가가 실제로 움직임', d.stocks.companies[cid].price !== before.price);
    check('마지막 점이 지금 주가와 같음',
        d.stocks.companies[cid].history[d.stocks.companies[cid].history.length - 1] === d.stocks.companies[cid].price);

    for (let i = 0; i < 5; i++) pressForceNews();
    check(`여섯 번 누르면 점 ${before.len + 6}개 — ${d.stocks.companies[cid].history.length}개`,
        d.stocks.companies[cid].history.length === before.len + 6);
    check('여러 번 눌러도 시간축이 맞음', axisOk());

    // 여러 번 눌러 회차가 앞서도, 자가회복이 되돌리지 않아야 함
    check('몇 번 눌러 앞선 정도는 자가회복이 건드리지 않음', app.clamp(d.stocks) === false);

    // 앞당긴 만큼 시간이 지나면 정시 뉴스가 다시 이어짐
    const aheadTick = d.stocks.lastTick;
    check('앞당긴 시간 안에는 정시 뉴스가 쉼', app.applyTicks(now) === false);
    check('그 시간이 지나면 다시 나옴', app.applyTicks(now + (aheadTick - Math.floor(now / app.K.TICK) + 2) * HOUR) === true);
    check('이어서 진행돼도 시간축이 맞음', axisOk());

    // 모든 회사가 함께 늘어야 함 (한 회사만 늘면 그래프가 어긋난다)
    const lengths = app.COMPANIES.map(c => d.stocks.companies[c.id].history.length);
    check('네 회사의 점 개수가 모두 같음', lengths.every(l => l === lengths[0]));
}

/* ── 앞당긴 점이 그래프 밖으로 삐져나가지 않아야 함 ──
   '뉴스 추가' 로 회차를 앞당기면 기록의 시각이 실제 시각보다 미래가 된다.
   가로축 오른쪽 끝을 실제 시각으로 잡으면 그 점들이 그림 영역 밖에 그려진다 (실제로 그랬다) */
{
    const now = Date.now();
    const d = { users: {}, stocks: null };
    app.setDb(d);
    d.stocks = app.initStock(now);
    const cid = app.COMPANIES[0].id;

    const seriesFits = () => {
        const pts = app.series(cid, 24);
        const right = pts[pts.length - 1].t;
        return pts.every(pt => pt.t <= right);
    };
    check('평소에는 모든 점이 가로축 안에 들어옴', seriesFits());

    // 뉴스 추가를 여섯 번 눌러 시장 시간을 6시간 앞당긴다
    for (let i = 0; i < 6; i++) {
        app.COMPANIES.forEach(c => app.event(Date.now(), c.id, true, true));
        d.stocks.lastTick += 1;
        app.push();
    }
    check('앞당긴 뒤에도 모든 점이 가로축 안에 들어옴', seriesFits());

    const pts = app.series(cid, 24);
    check(`앞당긴 점들이 그래프에 보임 — 점 ${pts.length}개`, pts.length >= 7);
    check('마지막 점이 지금 주가', pts[pts.length - 1].p === d.stocks.companies[cid].price);
    check('가로축 오른쪽 끝이 앞당긴 마지막 회차와 맞음',
        pts[pts.length - 1].t === d.stocks.lastTick * app.K.TICK);

    // 남은 시간이 실제로 기다려야 하는 시간이어야 함
    const mins = app.nextNews();
    check(`시장이 앞서 있으면 남은 시간도 그만큼 길어짐 — ${mins}분`, mins > 5 * 60);

    // 앞서 있지 않을 때는 한 시간 안으로 나와야 함
    const fresh = { users: {}, stocks: null };
    app.setDb(fresh);
    fresh.stocks = app.initStock(now);
    check(`평소 남은 시간은 한 시간 이내 — ${app.nextNews()}분`, app.nextNews() <= 60);
}

/* ── 회차 번호가 미래로 가 있으면 스스로 낫는지 ──
   회차가 미래면 applyStockTicks 가 곧바로 빠져나가 정시 뉴스가 영영 안 나온다.
   관리자 '뉴스 추가' 는 회차와 무관해서 주가만 움직이므로,
   '주가는 바뀌는데 그래프 점은 하나뿐' 인 상태가 된다 (실제로 그렇게 됐다) */
{
    const now = Date.now();
    const d = { users: {}, stocks: null };
    app.setDb(d);
    d.stocks = app.initStock(now);
    const cid = app.COMPANIES[0].id;

    // 간격을 환산하다 어긋난 상태를 흉내 낸다 (회차가 4배로 튀어 있음)
    d.stocks.lastTick = Math.floor(now / app.K.TICK) * 4;
    d.stocks.companies[cid].history = [15];
    d.stocks.historyStartTick = d.stocks.lastTick;

    check('회차가 미래면 정시 뉴스가 안 나옴 (증상 재현)', app.applyTicks(now) === false);
    check('회차를 지금으로 끌어내림', app.clamp(d.stocks) === true);
    check('바로잡은 회차가 현재와 맞음', d.stocks.lastTick === Math.floor(now / app.K.TICK));
    check('시간축도 함께 맞춤',
        d.stocks.historyStartTick + d.stocks.companies[cid].history.length - 1 === d.stocks.lastTick);
    check('바로잡은 뒤에는 더 건드리지 않음', app.clamp(d.stocks) === false);

    // 고친 뒤 실제로 점이 쌓이는지
    app.applyTicks(now + 5 * HOUR);
    check(`고친 뒤 5시간이면 점 6개 — ${d.stocks.companies[cid].history.length}개`,
        d.stocks.companies[cid].history.length === 6);

    // 정상 상태는 건드리지 않아야 함 (3시간 전에 시작해 지금까지 정상 진행)
    const ok = { users: {}, stocks: null };
    app.setDb(ok);
    ok.stocks = app.initStock(now - 3 * HOUR);
    check('정상 상태는 그대로 둠', app.clamp(ok.stocks) === false);
    app.applyTicks(now);
    const normalTick = ok.stocks.lastTick;
    check('정상적으로 회차가 진행된 뒤에도 그대로 둠',
        app.clamp(ok.stocks) === false && ok.stocks.lastTick === normalTick);

    // 기기 시계가 조금 빠른 경우는 정상으로 봐야 한다 (끌어내리면 같은 회차 기록이 두 번 쌓임)
    ok.stocks.lastTick = Math.floor(now / app.K.TICK) + 1;
    check('시계가 한 시간 빠른 정도는 그대로 둠', app.clamp(ok.stocks) === false);
    ok.stocks.lastTick = Math.floor(now / app.K.TICK) + 50;
    check('크게 어긋나면 고침', app.clamp(ok.stocks) === true);
}

/* ── 기록을 비운 뒤 실제로 다시 쌓이는지 ──
   비운 직후에는 점이 하나뿐이라 직선으로 보이는 게 정상이다.
   중요한 건 시간이 지나면 점이 늘고, 하루 안에 움직임이 나타나는 것 */
{
    const t0 = Date.UTC(2026, 0, 5);
    const d = { users: {}, stocks: null };
    app.setDb(d);
    d.stocks = app.initStock(t0);
    const cid = app.COMPANIES[0].id;
    d.stocks.companies[cid].history = [d.stocks.companies[cid].price];
    d.stocks.historyStartTick = d.stocks.lastTick;

    app.applyTicks(t0 + 1 * HOUR);
    check('1시간 뒤 점이 2개', d.stocks.companies[cid].history.length === 2);
    app.applyTicks(t0 + 6 * HOUR);
    check('6시간 뒤 점이 7개', d.stocks.companies[cid].history.length === 7);
    app.applyTicks(t0 + 24 * HOUR);
    const h24 = d.stocks.companies[cid].history;
    check(`하루 뒤 점이 25개 — ${h24.length}개`, h24.length === 25);
    check(`하루 뒤에는 주가가 움직여 있음 — 서로 다른 값 ${new Set(h24).size}개`, new Set(h24).size >= 3);
    check('시간축이 계속 맞음', d.stocks.historyStartTick + h24.length - 1 === d.stocks.lastTick);
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
    check(`24시간 안에 서로 다른 값이 여러 개 — 평균 ${(distinctSum / cnt).toFixed(1)}개`, distinctSum / cnt >= 5);
    check(`일자로 보이는 그래프가 거의 없음 — ${flatCharts}/${cnt}개`, flatCharts <= cnt * 0.1);

    // 주가가 하루 종일 한 번도 안 움직이면 무슨 수를 써도 일자로 보인다.
    // 하루를 여러 번 잘라서, 값이 두 종류 이하인 날이 거의 없는지 본다
    let flatDays = 0, dayCount = 0, bigJumps = 0, moves = 0;
    for (let r = 0; r < 10; r++) {
        const t0 = Date.UTC(2026, 0, 5);
        const d = { users: {}, stocks: null };
        app.setDb(d);
        d.stocks = app.initStock(t0);
        d.stocks.seed += r * 7919;
        for (let h = 1; h <= 10 * 24; h++) app.applyTicks(t0 + h * HOUR_MS2);
        app.COMPANIES.forEach(c => {
            const hist = d.stocks.companies[c.id].history;
            for (let w = 0; w < 5; w++) {
                const day = hist.slice(-(24 * (w + 1)), hist.length - 24 * w);
                if (day.length < 24) continue;
                dayCount++;
                if (new Set(day).size <= 2) flatDays++;
                for (let i = 1; i < day.length; i++) {
                    const diff = Math.abs(day[i] - day[i - 1]);
                    if (diff) moves++;
                    if (diff >= 3) bigJumps++;
                }
            }
        });
    }
    check(`주가가 하루 내내 멈춰 있는 날이 거의 없음 — ${(flatDays / dayCount * 100).toFixed(0)}%`,
        flatDays / dayCount <= 0.02);
    check(`갑자기 크게 튀는 움직임은 드묾 — ${(bigJumps / moves * 100).toFixed(1)}% (예전 22.5%)`,
        bigJumps / moves < 0.06);
}

[[15, 15, 15], [14, 15], [5, 5, 5], [5, 6, 7], [198, 200], [11, 13, 15, 12]].forEach(ps => {
    const { lo, hi } = app.scale(ps);
    check(`세로축이 늘 올바름 [${ps.join(',')}] → ${lo}~${hi}π`,
        hi > lo && lo <= Math.min(...ps) && hi >= Math.max(...ps)
        && lo >= app.K.MIN && hi <= 200 && (hi - lo) % 2 === 0);
});

/* ── 기사와 주가가 같은 말을 해야 함 ──
   예전에는 호재·악재를 먼저 정하고 변동 폭을 따로 굴려서, 누가 봐도 좋은 소식인데
   주가는 그대로인 기사가 나왔다 ('대형 계약 수주!' · 변동 없음).
   이제 호재면 반드시 오르고, 악재면 반드시 내리고, 안 움직이는 회차는 '잠잠' 기사가 된다. */
(function newsMatchesPrice() {
    const HOUR = 3600 * 1000, DAYS = 30;
    const start = Date.now() - DAYS * 24 * HOUR;
    const market = app.initStock(start);
    app.setDb({ users: {}, stocks: market, lotto: {}, bank: { loans: [], savings: [], logs: [] }, usageRequests: [] });

    let good = 0, bad = 0, flat = 0;
    let goodNotUp = 0, badNotDown = 0, flatMoved = 0, quietMismatch = 0, pairOneSided = 0;

    for (let h = 1; h <= DAYS * 24; h++) {
        const t = start + h * HOUR;
        market.lastTick = Math.floor(t / HOUR);
        app.COMPANIES.forEach(c => {
            const before = {};
            app.COMPANIES.forEach(x => { before[x.id] = market.companies[x.id].price; });
            const item = app.event(t, c.id, true);
            const d = (item.deltas || {})[item.companyId] || 0;
            const atFloor = before[item.companyId] <= app.K.MIN;
            const atCeil = before[item.companyId] >= 200;

            if (item.sentiment === 'good') {
                good++;
                if (d <= 0 && !atCeil) goodNotUp++;
            } else if (item.sentiment === 'bad') {
                bad++;
                if (d >= 0 && !atFloor) badNotDown++;
            } else if (item.sentiment === 'flat') {
                flat++;
                if (Object.values(item.deltas || {}).some(x => x !== 0)) flatMoved++;
                if (item.kind !== 'quiet') quietMismatch++;
            }
            // 계약 뉴스는 두 회사가 함께 움직여야 한다
            if (item.partnerId) {
                const dp = (item.deltas || {})[item.partnerId] || 0;
                const partnerStuck = before[item.partnerId] <= app.K.MIN || before[item.partnerId] >= 200;
                if (dp === 0 && !partnerStuck) pairOneSided++;
            }
        });
    }

    check(`뉴스가 충분히 나옴 — 호재 ${good} · 악재 ${bad} · 잠잠 ${flat}`, good > 100 && bad > 100 && flat > 100);
    check(`호재 기사는 반드시 주가가 오름 — 어긋난 기사 ${goodNotUp}건`, goodNotUp === 0);
    check(`악재 기사는 반드시 주가가 내림 — 어긋난 기사 ${badNotDown}건`, badNotDown === 0);
    check(`'잠잠' 기사는 주가를 움직이지 않음 — 어긋난 기사 ${flatMoved}건`, flatMoved === 0);
    check(`변동 없는 회차는 반드시 '잠잠' 기사 — 어긋난 기사 ${quietMismatch}건`, quietMismatch === 0);
    check(`계약 뉴스는 두 회사가 함께 움직임 — 한쪽만 움직인 기사 ${pairOneSided}건`, pairOneSided === 0);

    // '잠잠' 기사에도 회사마다 쓸 문장이 있어야 한다
    const missing = app.COMPANIES.filter(c => !(app.REASONS[c.id].flat || []).length);
    check('회사마다 잠잠한 날 기사 문장이 있음', missing.length === 0);
})();

/* ── 밤사이 움직인 주가에는 그만큼의 뉴스가 있어야 함 ──
   아무도 안 들어온 동안의 회차는 아침 첫 접속 때 한꺼번에 처리된다.
   예전에는 그때 최근 2회차의 뉴스만 남겨서, 그래프에는 밤새 움직인 자국이 있는데
   뉴스에는 두 시간치밖에 없었다. 주가가 왜 움직였는지 알 수 없었다. */
(function overnightNews() {
    const HOUR = 3600 * 1000;
    const GAP = 9;                       // 밤 10시 ~ 아침 7시
    const start = Date.now() - (GAP + 6) * HOUR;
    const market = app.initStock(start);
    app.setDb({ users: {}, stocks: market, lotto: {}, bank: { loans: [], savings: [], logs: [] }, usageRequests: [] });

    for (let h = 1; h <= 6; h++) app.tickTo(start + h * HOUR);   // 저녁까지는 정상 접속
    const before = app.COMPANIES.map(c => market.companies[c.id].price);
    const nightBegan = start + 6 * HOUR;

    app.tickTo(start + (6 + GAP) * HOUR);                        // 아침에 한 번에 따라잡음
    const after = app.COMPANIES.map(c => market.companies[c.id].price);
    const moved = before.reduce((sum, p, i) => sum + Math.abs(after[i] - p), 0);

    const night = market.news.filter(n => n.t > nightBegan);
    const hours = new Set(night.map(n => Math.floor(n.t / HOUR))).size;

    check(`밤사이 주가가 실제로 움직임 — ${moved}π`, moved > 0);
    check(`밤사이 뉴스가 남아 있음 — ${night.length}건 (예전 8건)`, night.length > 8);
    check(`뉴스가 빈 시간을 거의 다 덮음 — ${hours}시간 / ${GAP}시간 (예전 2시간)`, hours >= GAP - 1);
    // 아침에 '거의 움직이지 않았다' 기사로 목록이 가득 차면 안 된다
    const flat = night.filter(n => !Object.values(n.deltas || {}).some(d => d !== 0));
    check(`밀린 회차에서는 안 움직인 기사를 남기지 않음 — ${flat.length}건`, flat.length === 0);
    check(`목록이 한도를 넘지 않음 — ${market.news.length}건`, market.news.length <= 60);
})();

/* ── 경험치가 오르는 곳 ──
   쿠폰 말고 은행·주식을 이용해도 경험치가 오르게 했다. 다만 '되돌아오는 돈' 에
   경험치를 붙이면 주고받기·사고팔기를 되풀이해서 무한정 찍어낼 수 있으므로,
   시간을 들여야만 생기는 대가(이자·배당)에만 붙였다. 그게 실제로 그런지 확인한다. */
{
    const WEEK = 7 * DAY;
    const freshDb = () => ({
        users: { '1': { name: '1번', role: 'student', pi: 1000, exp: 0, inventory: [], lottoTickets: [], stocks: {} } },
        lotto: { currentPot: 0, rolloverPot: 0 }, usageRequests: [], notice: '',
        bank: { loans: [], savings: [], logs: [] }, stocks: app.initStock(Date.now() - DAY), couponPrices: {}
    });
    const expOf = d => d.users['1'].exp;

    /* 적금: 만기까지 채우면 이자만큼, 중도 해지하면 없음 */
    {
        const d = freshDb();
        const weeks = 2, principal = 100;
        const started = Date.now() - weeks * WEEK - 1000;
        const sv = { id: 's1', studentId: '1', principal, weeks, weeklyRatePct: app.savingsRatePct(weeks),
                     startAt: started, maturesAt: started + weeks * WEEK, status: 'active' };
        d.bank.savings.push(sv);
        app.setDb(d);
        app.timeTick();
        const interest = app.savingsPayoutOf(sv) - principal;
        check(`적금 만기 → 이자만큼 경험치 +${expOf(d)} (이자 ${interest}π)`, expOf(d) === interest && interest > 0);
        const before = expOf(d);
        app.timeTick(); app.timeTick();
        check('적금 만기 경험치가 두 번 들어오지 않음', expOf(d) === before);
    }
    {
        // 중도 해지한 적금은 만기가 지나도 경험치를 주지 않아야 한다
        const d = freshDb();
        const started = Date.now() - 3 * WEEK;
        d.bank.savings.push({ id: 's2', studentId: '1', principal: 100, weeks: 2, weeklyRatePct: app.savingsRatePct(2),
                              startAt: started, maturesAt: started + 2 * WEEK, status: 'canceled', closedAt: started + DAY });
        app.setDb(d); app.timeTick();
        check('중도 해지한 적금은 경험치가 없음', expOf(d) === 0);
    }

    /* 주식 배당: 2주 넘게 들고 있어야 나오므로 사고팔기로 만들 수 없다 */
    {
        const d = freshDb();
        const cid = app.COMPANIES[0].id;
        d.users['1'].stocks[cid] = [{ q: 10, cost: 100, at: Date.now() - 15 * DAY, paid: 0 }];
        app.setDb(d);
        const piBefore = d.users['1'].pi;
        app.timeTick();
        const paid = d.users['1'].pi - piBefore;
        check(`주식 배당 → 배당금만큼 경험치 +${expOf(d)} (배당 ${paid}π)`, paid > 0 && expOf(d) === paid);
    }
    {
        // 방금 산 주식은 배당도 경험치도 없다
        const d = freshDb();
        const cid = app.COMPANIES[0].id;
        d.users['1'].stocks[cid] = [{ q: 10, cost: 100, at: Date.now(), paid: 0 }];
        app.setDb(d); app.timeTick();
        check('방금 산 주식으로는 경험치를 만들 수 없음', expOf(d) === 0);
    }

    /* 대출 연체는 예전처럼 경험치를 깎아야 한다 */
    {
        const d = freshDb();
        const started = Date.now() - 20 * DAY;
        d.users['1'].exp = 100;
        d.bank.loans.push({ id: 'l1', studentId: '1', principal: 10, paid: 0, startAt: started,
                            dueAt: started + 8 * DAY, penaltiesApplied: 0, status: 'active' });
        app.setDb(d); app.timeTick();
        check(`대출 연체는 여전히 경험치를 깎음 — ${d.users['1'].exp} (연체 전 100)`, d.users['1'].exp < 100);
    }
}

/* ── 랜덤상자 확률이 쿠폰 가격과 어긋나지 않아야 함 ──
   확률을 표에 적어 두면, 관리자가 상점에서 쿠폰 값을 바꾼 순간 둘이 어긋난다.
   (80π 쿠폰이 5π 쿠폰보다 흔해지는 일도 생길 수 있다)
   그래서 확률을 '지금 쿠폰 가격' 에서 그때그때 계산한다. 그게 실제로 되는지 확인한다. */
{
    const boxStats = (prices) => {
        app.setDb({ users: {}, couponPrices: prices || {} });
        const odds = app.boxOdds();
        let ev = 0, cash = 0;
        odds.forEach(({ reward: r, p }) => {
            const v = app.boxValue(r);
            if (r.hiddenTrigger) {
                ev += p * (v * (1 - app.BOX.HID_CH) + app.BOX.HID.amount * app.BOX.HID_CH);
                cash += p * app.BOX.HID_CH * app.BOX.HID.amount;
            } else ev += p * v;
            if (r.type === 'pi') cash += p * r.amount;
        });
        const at = name => odds.find(o => o.reward.name === name).p;
        return { odds, ev, cash, at, total: odds.reduce((s, o) => s + o.p, 0) };
    };

    check(`히든 보상이 ${app.HIDDEN.amount}파이`, app.HIDDEN.amount === 333 && app.HIDDEN.name === '333파이');

    const base = boxStats();
    check(`상자 확률 합계가 100% — ${(base.total * 100).toFixed(3)}%`, Math.abs(base.total - 1) < 1e-9);
    check(`상자가 파이를 늘리지 않음 — ${app.BOX.PRICE}π 내고 ${base.cash.toFixed(2)}π 생김`,
        base.cash < app.BOX.PRICE);
    // 예전 손으로 만든 표와 같은 수준이어야 물가가 흔들리지 않는다 (기대값 1.63π · 현금 0.92π 였다)
    check(`기대값이 예전 수준 — ${base.ev.toFixed(2)}π (예전 1.63π)`, Math.abs(base.ev - 1.63) < 0.15);
    check(`현금 창출이 예전 수준 — ${base.cash.toFixed(2)}π (예전 0.92π)`, Math.abs(base.cash - 0.92) < 0.08);

    // 비싼 쿠폰이 싼 쿠폰보다 흔하면 안 된다
    const couponNames = app.COUPONS.map(c => c.name).filter(n => base.odds.some(o => o.reward.name === n));
    let ordered = true;
    for (const a of couponNames) for (const b of couponNames) {
        if (app.basePrice(app.COUPONS.find(c => c.name === a)) < app.basePrice(app.COUPONS.find(c => c.name === b))
            && base.at(a) < base.at(b) - 1e-12) ordered = false;
    }
    check('싼 쿠폰이 비싼 쿠폰보다 흔함 (거꾸로 된 곳 없음)', ordered);

    // 학생이 평생 한 번도 못 보는 상품이 없어야 한다
    const rarest = Math.min(...base.odds.filter(o => o.reward.type !== 'none').map(o => o.p));
    check(`가장 드문 상품도 ${Math.round(1 / rarest)}번에 한 번 (바닥 ${Math.round(1 / app.BOX.MIN)}번)`,
        rarest >= app.BOX.MIN - 1e-12);

    // 관리자가 쿠폰 값을 바꾸면 확률이 따라와야 한다
    const dearer = boxStats({ '청소 면제권': 40 });
    check(`쿠폰을 비싸게 하면 더 귀해짐 — 10π 때 ${(base.at('청소 면제권') * 100).toFixed(3)}% → 40π 때 ${(dearer.at('청소 면제권') * 100).toFixed(3)}%`,
        dearer.at('청소 면제권') < base.at('청소 면제권'));
    const cheaper = boxStats({ '짝꿍 선택권': 6 });
    check(`쿠폰을 싸게 하면 더 흔해짐 — 80π 때 ${(base.at('짝꿍 선택권') * 100).toFixed(3)}% → 6π 때 ${(cheaper.at('짝꿍 선택권') * 100).toFixed(3)}%`,
        cheaper.at('짝꿍 선택권') > base.at('짝꿍 선택권'));

    // 쿠폰을 공짜로 만들어도 상자가 그것만 주면 안 된다
    const free = boxStats({ '청소 면제권': 0 });
    check(`공짜 쿠폰이 상자를 삼키지 않음 — ${(free.at('청소 면제권') * 100).toFixed(1)}% (천장 ${app.BOX.MAX * 100}%)`,
        free.at('청소 면제권') <= app.BOX.MAX + 1e-9);
    check('그때도 확률 합계는 100%', Math.abs(free.total - 1) < 1e-9);

    /* ── 목록 차례가 가격과 어긋나지 않아야 함 ──
       선생님이 쿠폰 값을 바꾸자 상점에서 청소 면제권(20π)이 반장 간식 갈취권(25π)보다
       위에 있었다. 상자 확률표도 간식 교환권(15π)이 6파이보다 위에 있었다.
       손으로 적어 둔 차례라서 값을 바꾸면 그대로 어긋난다. 이제 지금 가격으로 늘어놓는다. */
    const MINE = { '짝꿍 선택권': 95, '자리 지정권': 75, '3일 자리 선택권': 30, '청소 면제권': 20,
                   '반장 간식 갈취권': 25, '간식 교환권': 15, '음악 우선 신청권': 3 };
    const mine = boxStats(MINE);
    const vals = mine.odds.map(o => app.boxValue(o.reward));
    check('상자 목록이 값어치 오름차순 (꽝이 맨 위)',
        vals.every((v, i) => i === 0 || v >= vals[i - 1]));
    // 값어치가 같으면 확률도 같아야 한다 (15파이와 15π 짜리 쿠폰)
    const same = mine.odds.filter(o => app.boxValue(o.reward) === 15).map(o => o.p);
    check(`값어치가 같으면 확률도 같음 — 15π 짜리 ${same.length}개`,
        same.length >= 2 && Math.abs(same[0] - same[1]) < 1e-12);

    app.setDb({ users: {}, couponPrices: MINE });
    const listed = app.byPrice();
    const prices = listed.map(x => app.basePrice(x.coupon));
    check(`상점이 비싼 것부터 — ${listed.map(x => app.basePrice(x.coupon)).join(', ')}π`,
        prices.every((v, i) => i === 0 || v <= prices[i - 1]));
    // 차례를 바꿔도 '구매' 버튼이 엉뚱한 쿠폰을 사면 안 된다
    check('차례를 바꿔도 구매 버튼이 제 쿠폰을 가리킴',
        listed.every(x => app.COUPONS[x.idx] === x.coupon));
    check('빠지거나 겹치는 쿠폰 없음',
        listed.length === app.COUPONS.length && new Set(listed.map(x => x.idx)).size === app.COUPONS.length);

    // 터무니없는 값이 저장돼 있어도 버텨야 함
    [-5, 1.5, '20', null, NaN].forEach(bad => {
        const r = boxStats({ '청소 면제권': bad });
        check(`이상한 쿠폰 값(${String(bad)})에도 확률이 멀쩡함`, Math.abs(r.total - 1) < 1e-9 && r.ev > 0);
    });
}

/* ── 주가가 제 갈 길을 가되, 바닥에 눌러앉거나 끝없이 오르지 않아야 함 ──
   예전에는 기준가를 늘 '시작 주가' 로 끌어당겨서, 어떤 회사든 결국 제자리로 돌아왔다.
   그 힘을 없애고 양 끝에서만 붙잡도록 바꿨다. 그래서 확인할 것이 세 가지다.
     1) 정말 제자리로 안 돌아오는가 (회사마다 새 자리를 찾는가)
     2) 그렇다고 최저가에 눌러앉지는 않는가 ('아래로만 간다' 던 문제)
     3) 그렇다고 끝없이 오르지도 않는가 (10주 든 학생 재산이 수백 π 가 되면 물가가 무너짐) */
(function priceBand() {
    const HOUR = 3600 * 1000, DAYS = 60, SEEDS = 3;
    let floorSamples = 0, samples = 0, maxPrice = 0;
    let driftSum = 0, moveAwaySum = 0, n = 0;

    for (let k = 0; k < SEEDS; k++) {
        const start = Date.now() - DAYS * 24 * HOUR;
        const market = app.initStock(start);
        market.seed += k * 7919;
        app.setDb({ users: {}, stocks: market, lotto: {}, bank: { loans: [], savings: [], logs: [] }, usageRequests: [] });
        for (let h = 1; h <= DAYS * 24; h++) {
            app.tickTo(start + h * HOUR);
            app.COMPANIES.forEach(c => {
                const p = market.companies[c.id].price;
                samples++; if (p <= app.K.MIN + 1) floorSamples++;
                maxPrice = Math.max(maxPrice, p);
            });
        }
        const finals = app.COMPANIES.map(c => market.companies[c.id].price);
        const starts = app.COMPANIES.map(c => c.startPrice);
        driftSum += finals.reduce((a, b) => a + b, 0) / starts.reduce((a, b) => a + b, 0) - 1;
        moveAwaySum += finals.reduce((sum, p, i) => sum + Math.abs(p - starts[i]) / starts[i], 0) / finals.length;
        n++;
    }
    const floorPct = floorSamples / samples * 100;
    const drift = driftSum / n * 100;
    const moveAway = moveAwaySum / n * 100;

    check(`회사가 제자리로 돌아오지 않음 — 시작가에서 평균 ${moveAway.toFixed(0)}% 떨어진 곳에 있음`,
        moveAway >= 20);
    check(`최저가에 눌러앉지 않음 — 바닥 부근에 머문 시간 ${floorPct.toFixed(1)}% (받침 넣기 전 7.5%)`,
        floorPct < 3);
    check(`${DAYS}일 지나도 전체 물가가 크게 밀리지 않음 — ${drift >= 0 ? '+' : ''}${drift.toFixed(0)}%`,
        Math.abs(drift) <= 25);
    check(`주가가 학생 재산을 무너뜨릴 만큼 비싸지지 않음 — 최고 ${maxPrice}π (${app.K.TOTAL}주 들면 ${maxPrice * app.K.TOTAL}π)`,
        maxPrice <= 70);
})();

/* ── 계약이 너무 빨리 끊어지지 않아야 함 ──
   회사가 넷이라 짝은 여섯뿐인데 1시간마다 네 회사의 뉴스가 나온다. 그래서 한 짝이
   다시 등장할 확률이 시간당 20% 나 되고, 예전에는 그때 나쁜 소식이면 바로 해지되어
   계약이 반나절도 못 갔다 (중앙값 9시간, 89%가 하루를 못 넘김).
   진짜 주식 엔진을 120일 돌려서 확인한다. */
(function contractLifetimes() {
    const HOUR = 3600 * 1000;
    const DAYS = 120;
    const start = Date.now() - DAYS * 24 * HOUR;
    const market = app.initStock(start);
    app.setDb({ users: {}, stocks: market, lotto: {}, bank: { loans: [], savings: [], logs: [] }, usageRequests: [] });

    const signedAt = {}, endedAt = {}, lives = [];
    let maxAtOnce = 0, tooSoonRejoin = 0;
    let prev = new Set();
    for (let h = 1; h <= DAYS * 24; h++) {
        app.tickTo(start + h * HOUR);
        const now = new Set(market.contracts);
        for (const k of now) if (!prev.has(k)) {
            signedAt[k] = h;
            if (endedAt[k] !== undefined && h - endedAt[k] < app.CONTRACT.COOLDOWN) tooSoonRejoin++;
        }
        for (const k of prev) if (!now.has(k)) { lives.push(h - signedAt[k]); endedAt[k] = h; }
        maxAtOnce = Math.max(maxAtOnce, now.size);
        prev = now;
    }
    lives.sort((a, b) => a - b);
    const median = lives[Math.floor(lives.length / 2)];
    const shortest = lives[0];
    const underADay = lives.filter(x => x < 24).length;

    check(`계약이 여러 번 맺고 끊어질 만큼 돌아감 — ${lives.length}건`, lives.length >= 20);
    check(`가장 짧은 계약도 최소 유지 기간을 채움 — ${shortest}시간 (기준 ${app.CONTRACT.MIN_TICKS})`,
        shortest >= app.CONTRACT.MIN_TICKS);
    check(`하루도 못 간 계약이 없음 — ${underADay}건 (예전 89%)`, underADay === 0);
    check(`계약이 보통 이틀은 넘게 감 — 중앙값 ${median}시간 (${(median / 24).toFixed(1)}일, 예전 9시간)`,
        median >= 48);
    // 오래 간다고 여섯 짝이 모두 묶여 버리면, 모든 회사가 같이 움직여서 재미가 없어진다
    check(`동시 계약이 상한을 넘지 않음 — 최대 ${maxAtOnce}개 (상한 ${app.CONTRACT.MAX})`,
        maxAtOnce <= app.CONTRACT.MAX);
    check('끊기자마자 같은 짝이 다시 맺지 않음', tooSoonRejoin === 0);
})();

console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
const failed = results.filter(x => !x[1]).length;
console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
process.exit(failed === 0 ? 0 : 1);
