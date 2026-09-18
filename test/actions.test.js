/*
 * 학생이 한 일이 사라지지 않는지 확인하는 테스트
 *
 * 실행:  node test/actions.test.js
 *
 * index.html 의 실제 코드(주식·쿠폰·로또·송금·대출·적금·랜덤상자)를 그대로 불러와,
 * 서버를 흉내 낸 환경에서 '다른 기기와 저장이 겹치는' 상황을 만들어 봅니다.
 *
 * 확인하는 것:
 *   서른 명이 같은 시간에 쓰면, 자료를 읽은 뒤 저장하기까지의 짧은 사이에
 *   다른 사람이 먼저 저장하는 일이 자주 생긴다. 예전에는 그때 저장이 조용히
 *   버려지는데도 화면에는 '완료되었습니다' 가 떴다. 학생 눈에는 분명히 했는데
 *   없어진 것처럼 보였다 (주식이 사라지던 증상). 그 일이 어디에서도 다시 생기면 안 된다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

/* ---------- 브라우저·서버 흉내 ---------- */
const stub = () => ({ addEventListener(){}, style:{}, classList:{add(){},remove(){},contains:()=>false},
    textContent:'', innerHTML:'', value:'', disabled:false, appendChild(){}, remove(){},
    querySelectorAll:()=>[], children:[] });
global.document = { getElementById: stub, createElement: stub, addEventListener(){}, body: stub(),
    querySelectorAll: () => [], visibilityState: 'visible' };
global.window = { addEventListener(){}, innerWidth: 400 };
global.location = { protocol: 'https:', hostname: 'x.pages.dev', reload(){} };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.setInterval = () => 0; global.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return 0; };

let alerts = [];
global.alert = m => alerts.push(String(m));
global.confirm = () => true;

let server = null;        // 서버에 들어 있다고 가정하는 내용
let beforeNextSave = null; // 다음 저장 직전에 딱 한 번 끼어드는 다른 기기

global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/api/data')) throw new Error('저장소에 직접 접속하면 안 됩니다: ' + u);
    const method = opts.method || 'GET';
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });

    if (method === 'GET') {
        return ok({ record: JSON.parse(JSON.stringify(server)), rev: server.rev || 0 });
    }
    if (method === 'PUT') {
        // 저장 직전에 다른 기기가 먼저 저장하는 상황 (한 시간마다 뉴스가 뜰 때 실제로 벌어짐)
        if (beforeNextSave) { const f = beforeNextSave; beforeNextSave = null; f(); }
        const { baseRev, record } = JSON.parse(opts.body);
        const currentRev = server.rev || 0;
        if (currentRev !== baseRev) {
            return { ok: false, status: 409, json: async () => ({ error: 'conflict', rev: currentRev, record: server }) };
        }
        server = JSON.parse(JSON.stringify({ ...record, rev: currentRev + 1 }));
        return ok({ ok: true, rev: currentRev + 1 });
    }
    throw new Error('예상하지 못한 요청: ' + method);
};

const app = {};
eval(script + `
  app.buy = buyStock; app.sell = sellStock;
  app.setUser = id => { currentUser = id; };
  app.getDb = () => db;
  app.holdingOf = holdingOf;
  app.initStock = initStockMarket;
  app.COMPANIES = COMPANIES;
  app.BUILD = APP_BUILD;
  app.load = () => loadData({ silent: true });
  app.buyItem = buyItem; app.buyLotto = buyLotto; app.transfer = sendTransfer;
  app.takeLoan = takeLoan; app.openSavings = openSavings; app.box = buyRandomBox;
  app.COUPONS = COUPONS; app.couponPriceFor = couponPriceFor;
  app.repay = repayLoan; app.loanInterest = loanInterest;
`);

/* ---------- 도구 ---------- */
const CO = app.COMPANIES[0].id;

// 화면의 입력칸이 어떤 값을 담고 있는지 정해 준다
let inputs = {};
const elements = {};
global.document.getElementById = (id) => {
    const key = String(id);
    if (!elements[key]) elements[key] = stub();
    if (key in inputs) elements[key].value = String(inputs[key]);
    return elements[key];
};
function setOrderQty(n) {
    inputs = {};
    for (const c of ['taehoon', 'ttaek', 'dohoo', 'pharma23']) inputs['qty-' + c] = n;
}
function setInputs(map) { inputs = { ...map }; }

function freshServer(price = 20, pi = 100) {
    const market = app.initStock(Date.now());
    Object.keys(market.companies).forEach(id => {
        market.companies[id].price = price;
        market.companies[id].anchor = price;
    });
    return {
        rev: 5,
        users: {
            admin: { name: '관리자', role: 'admin', password: '00', pi: 0, exp: 0, inventory: [], lottoTickets: [], stocks: {} },
            '7': { name: '7번 학생', role: 'student', password: '7', pi, exp: 0, inventory: [], lottoTickets: [], stocks: {} },
            '8': { name: '8번 학생', role: 'student', password: '8', pi: 50, exp: 0, inventory: [], lottoTickets: [], stocks: {} }
        },
        lotto: { currentPot: 0, rolloverPot: 0 },
        usageRequests: [], notice: '', bank: { loans: [], savings: [], logs: [] },
        stocks: market,
        lastSave: { at: new Date().toISOString(), by: '테스트', v: 'test', build: app.BUILD }
    };
}

// 학생이 주식 화면을 열어, 화면에 이미 자료가 떠 있는 상태로 만든다
async function openScreen() { await app.load(); }

const heldOnServer = () => app.holdingOf(server.users['7'], CO).qty;
const piOnServer = () => server.users['7'].pi;
const saidBought = () => alerts.some(m => /샀어요|팔았어요/.test(m));

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
    /* ── 평소: 그냥 사진다 ── */
    server = freshServer();
    alerts = []; setOrderQty(2);
    app.setUser('7');
    await openScreen();
    await app.buy(CO);
    check('평범할 때 주식을 산다', heldOnServer() === 2);
    check('산 만큼 파이가 줄어든다', piOnServer() === 100 - 40);
    check('샀다고 알려준다', saidBought());

    /* ── 핵심: 저장 직전에 다른 기기가 먼저 저장한 경우 ──
       예전에는 여기서 주문이 버려지는데도 '샀어요!' 가 떴다 (주식이 사라지던 증상) */
    server = freshServer();
    alerts = []; setOrderQty(3);
    await openScreen();
    beforeNextSave = () => { server.rev += 1; server.notice = '다른 기기가 먼저 저장함'; };
    await app.buy(CO);
    check('겹쳐도 주식이 사라지지 않는다', heldOnServer() === 3);
    check('겹쳐도 파이가 맞다', piOnServer() === 100 - 60);
    check('다른 기기가 저장한 내용도 그대로 남는다', server.notice === '다른 기기가 먼저 저장함');
    check('겹쳤다고 학생을 놀라게 하지 않는다', !alerts.some(m => /덮어쓰지 않고|새로고침/.test(m)));
    check('그래도 샀다고 알려준다', saidBought());

    /* ── 파는 쪽도 같아야 한다 ── */
    server = freshServer();
    server.users['7'].stocks[CO] = [{ q: 4, cost: 80, at: Date.now(), paid: 0 }];
    alerts = []; setOrderQty(4);
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.sell(CO);
    check('겹쳐도 판 것이 제대로 반영된다', heldOnServer() === 0);
    check('판 만큼 파이를 받는다', piOnServer() === 100 + 80);

    /* ── 끝내 저장되지 않으면, 샀다고 거짓말하면 안 된다 ── */
    server = freshServer();
    alerts = []; setOrderQty(1);
    await openScreen();
    const bump = () => { server.rev += 1; beforeNextSave = bump; };   // 매번 끼어듦
    beforeNextSave = bump;
    await app.buy(CO);
    beforeNextSave = null;
    check('끝내 안 되면 주식도 파이도 그대로', heldOnServer() === 0 && piOnServer() === 100);
    check('끝내 안 되면 샀다고 하지 않는다', !saidBought());
    check('안 됐다고 분명히 알려준다', alerts.some(m => /처리되지 않았어요/.test(m)));

    /* ── 살 수 없는 상황은 예전처럼 그대로 막아야 한다 ── */
    server = freshServer(20, 10);        // 파이 10 으로 2주(40π)는 못 삼
    alerts = []; setOrderQty(2);
    await openScreen();
    await app.buy(CO);
    check('파이가 모자라면 사지 않는다', heldOnServer() === 0 && piOnServer() === 10);
    check('왜 안 되는지 알려준다', alerts.some(m => /파이가 부족/.test(m)));

    server = freshServer(5);             // 최저가에서는 살 수 없음
    alerts = []; setOrderQty(1);
    await openScreen();
    await app.buy(CO);
    check('최저가에서는 사지 않는다', heldOnServer() === 0);
    check('최저가라고 알려준다', alerts.some(m => /최저가/.test(m)));

    server = freshServer();
    alerts = []; setOrderQty(10);
    server.users['7'].pi = 10000;
    await openScreen();
    await app.buy(CO);
    const held = heldOnServer();
    alerts = []; setOrderQty(10);
    await app.buy(CO);                   // 한도(전체 10주)를 넘겨 또 사려 함
    check('보유 한도를 넘겨 사지 않는다', heldOnServer() === held);
    check('한도라고 알려준다', alerts.some(m => /주까지/.test(m)));

    server = freshServer();
    alerts = []; setOrderQty(1);
    await openScreen();
    await app.sell(CO);                  // 가진 게 없는데 팔려 함
    check('없는 주식은 팔지 않는다', piOnServer() === 100);
    check('없다고 알려준다', alerts.some(m => /부족/.test(m)));

    /* ══════════════════ 주식 말고 다른 것들 ══════════════════
       똑같은 '겹치면 조용히 버려지는' 문제가 있었다. 전부 같은 방식으로 고쳤다. */

    const student = () => server.users['7'];

    // ── 쿠폰 구매 ──
    server = freshServer(20, 500);
    alerts = []; setInputs({});
    await openScreen();
    const couponPrice = app.couponPriceFor('7', app.COUPONS[0]);
    beforeNextSave = () => { server.rev += 1; };
    await app.buyItem(0);
    check('쿠폰: 겹쳐도 산 쿠폰이 남는다', student().inventory.length === 1);
    check('쿠폰: 겹쳐도 파이가 맞다', student().pi === 500 - couponPrice);
    check('쿠폰: 샀다고 알려준다', alerts.some(m => /구매가 완료/.test(m)));

    // ── 송금 (돈이 사라지면 제일 곤란하다) ──
    server = freshServer(20, 500);
    alerts = []; setInputs({ transferTo: '8', transferAmount: 30 });
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.transfer();
    check('송금: 겹쳐도 보낸 사람 파이가 줄어든다', student().pi === 470);
    check('송금: 겹쳐도 받는 사람 파이가 늘어난다', server.users['8'].pi === 80);
    check('송금: 보냈다고 알려준다', alerts.some(m => /보냈어요/.test(m)));

    // 송금은 한 쪽만 반영되는 일이 절대 없어야 한다
    server = freshServer(20, 500);
    alerts = []; setInputs({ transferTo: '8', transferAmount: 30 });
    await openScreen();
    const keepBump = () => { server.rev += 1; beforeNextSave = keepBump; };
    beforeNextSave = keepBump;
    await app.transfer();
    beforeNextSave = null;
    check('송금: 끝내 안 되면 양쪽 다 그대로', student().pi === 500 && server.users['8'].pi === 50);
    check('송금: 끝내 안 되면 보냈다고 하지 않는다', !alerts.some(m => /보냈어요/.test(m)));

    // ── 로또 ──
    server = freshServer(20, 500);
    alerts = []; setInputs({ lottoNumbersInput: '1,2,3,4,5' });
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.buyLotto();
    check('로또: 겹쳐도 표가 남는다', student().lottoTickets.length === 1);
    check('로또: 겹쳐도 당첨금이 쌓인다', server.lotto.currentPot > 0);

    // ── 대출 ──
    server = freshServer(20, 500);
    alerts = []; setInputs({ loanAmountInput: 10 });   // 브론즈 등급 한도
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.takeLoan();
    check('대출: 겹쳐도 빌린 돈이 들어온다', student().pi === 510);
    check('대출: 겹쳐도 갚을 기록이 남는다', server.bank.loans.length === 1);
    check('대출: 돈과 기록이 따로 놀지 않는다',
        (student().pi === 510) === (server.bank.loans.length === 1));

    // ── 적금 ──
    server = freshServer(20, 500);
    alerts = []; setInputs({ savingsAmountInput: 100, savingsTermSelect: 2 });
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.openSavings();
    check('적금: 겹쳐도 가입이 남는다', server.bank.savings.length === 1);
    check('적금: 겹쳐도 파이가 맞다', student().pi === 400);

    // ── 랜덤상자 (연출 전에 반드시 저장되어야 함) ──
    server = freshServer(20, 500);
    alerts = []; setInputs({});
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.box();
    check('랜덤상자: 겹쳐도 결과가 저장된다', student().pi !== 500 || student().inventory.length > 0 || student().lottoTickets.length > 0);

    server = freshServer(20, 500);
    alerts = []; setInputs({});
    await openScreen();
    const boxBump = () => { server.rev += 1; beforeNextSave = boxBump; };
    beforeNextSave = boxBump;
    await app.box();
    beforeNextSave = null;
    check('랜덤상자: 끝내 안 되면 열지 않은 것으로 둔다',
        student().pi === 500 && student().inventory.length === 0 && student().lottoTickets.length === 0);

    // ── 할 수 없는 일은 예전처럼 그대로 막아야 한다 ──
    server = freshServer(20, 1);
    alerts = []; setInputs({ transferTo: '8', transferAmount: 30 });
    await openScreen();
    await app.transfer();
    check('파이보다 많이 보내지 못한다', student().pi === 1 && server.users['8'].pi === 50);

    server = freshServer(20, 500);
    alerts = []; setInputs({ transferTo: '7', transferAmount: 10 });
    await openScreen();
    await app.transfer();
    check('자기 자신에게는 보내지 못한다', student().pi === 500);

    /* ── 대출을 갚으면 낸 이자만큼 경험치 ──
       빌리자마자 갚으면 이자가 0 이라 경험치도 0 이어야 한다.
       안 그러면 빌렸다 갚기를 되풀이하는 것만으로 등급을 올릴 수 있다. */
    const WEEK = 7 * 24 * 3600 * 1000;
    const withLoan = (startedAgoMs) => {
        const sv = freshServer(20, 500);
        const started = Date.now() - startedAgoMs;
        sv.bank.loans.push({ id: 'l1', studentId: '7', principal: 50, paid: 0, startAt: started,
                             dueAt: started + 14 * 24 * 3600 * 1000, penaltiesApplied: 0, status: 'active' });
        sv.users['7'].exp = 0;
        return sv;
    };

    server = withLoan(WEEK);           // 빌린 지 1주 → 이자가 붙었다
    alerts = []; setInputs({});
    await openScreen();
    const owed = app.loanInterest(server.bank.loans[0]);
    await app.repay(true);
    check(`대출을 다 갚으면 낸 이자만큼 경험치 +${server.users['7'].exp} (이자 ${owed}π)`,
        owed > 0 && server.users['7'].exp === owed);
    check('다 갚았다고 표시됨', server.bank.loans[0].status === 'repaid');
    check('학생에게도 경험치를 알려줌', alerts.some(m => /경험치 \+/.test(m)));

    server = withLoan(0);              // 빌리자마자 갚음 → 이자 0
    alerts = []; setInputs({});
    await openScreen();
    await app.repay(true);
    check('빌리자마자 갚으면 경험치가 오르지 않음 (되풀이해서 찍어낼 수 없음)',
        server.bank.loans[0].status === 'repaid' && server.users['7'].exp === 0);

    // 겹쳐도 경험치와 잔액이 어긋나면 안 된다
    server = withLoan(WEEK);
    alerts = []; setInputs({});
    await openScreen();
    const owed2 = app.loanInterest(server.bank.loans[0]);
    beforeNextSave = () => { server.rev += 1; };
    await app.repay(true);
    check('겹쳐도 상환과 경험치가 함께 반영됨',
        server.bank.loans[0].status === 'repaid' && server.users['7'].exp === owed2);

    console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
    const failed = results.filter(x => !x[1]).length;
    console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
