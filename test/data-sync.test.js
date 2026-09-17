/*
 * 저장 충돌 방지 테스트
 *
 * 실행:  node test/data-sync.test.js
 *
 * index.html 의 '서버 데이터' 부분(loadData / saveData)만 떼어내서,
 * 서버와 네트워크를 흉내 낸 가짜 환경에서 돌려봅니다.
 * 진짜 저장소에는 접속하지 않으므로 학급 데이터가 바뀌지 않습니다.
 *
 * 확인하는 것: 오래된 화면이 서버 내용을 통째로 덮어쓰지 못하는가
 * (밤사이 쌓인 기록이 아침에 사라지던 문제)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const START = '    /* ===================== 서버 데이터 ===================== */';
const END = '    // 예전 데이터에 없던 항목을 채워 넣음';
if (!html.includes(START) || !html.includes(END)) {
    console.error('index.html 에서 서버 데이터 부분을 찾지 못했습니다. 주석이 바뀌었는지 확인하세요.');
    process.exit(1);
}
const dataLayer = html.slice(html.indexOf(START), html.indexOf(END));

/* ---------- 가짜 환경 ---------- */
const BIN_ID = 'test-bin';
const API_KEY = 'test-key';
let db = {};
let server = null;       // 저장소에 들어 있다고 가정하는 내용
let netUp = true;        // false 면 모든 요청 실패
let failGets = 0;        // 앞으로 N번의 읽기만 실패 (재시도 확인용)
let alerts = [];
let currentUser = null;   // index.html 의 로그인 상태 (저장 기록용)
let serverFnUp = true;    // /api/data (Cloudflare 함수) 사용 가능 여부
let putBodies = [];       // 저장 요청으로 실제 나간 내용

// 브라우저 전역 흉내
const location = { protocol: 'https:', hostname: 'example.pages.dev' };
const store = {};
const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
};
const document = { getElementById: () => null, createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
const esc = v => String(v);

const alert = m => alerts.push(m);
const confirm = () => true;
function initDefaultData() { db = { users: { admin: {}, '1': {} }, lotto: {}, usageRequests: [], notice: '', bank: {} }; }
function migrateData() { if (typeof db.rev !== 'number') { db.rev = 0; return true; } return false; }
function applyTimeBasedUpdates() { return false; }
function scheduleAiNews() { }

function revOfRecord(r) { return r && typeof r.rev === 'number' ? r.rev : 0; }
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function fetch(url, opts = {}) {
    if (!netUp) throw new Error('network down');
    const method = opts.method || 'GET';
    const viaServerFn = String(url).startsWith('/api/data');

    if (!viaServerFn) throw new Error('저장소에 직접 접속하면 안 됩니다: ' + url);
    if (!serverFnUp) return res(503, { error: 'JSONBIN_KEY 환경 변수가 설정되지 않았어요.' });

    if (method === 'GET') {
        if (failGets > 0) { failGets--; throw new Error('transient'); }
        const copy = JSON.parse(JSON.stringify(server));
        return res(200, viaServerFn ? { record: copy, rev: revOfRecord(copy) } : { record: copy });
    }

    if (viaServerFn && method === 'PUT') {
        // 서버 함수: 판번호가 맞을 때만 저장 (구조적 방어)
        const { baseRev, record } = JSON.parse(opts.body);
        if (!record || !record.users || Object.keys(record.users).length === 0) {
            return res(400, { error: '학생 정보 없음' });
        }
        if (revOfRecord(server) !== baseRev) {
            return res(409, { error: 'conflict', rev: revOfRecord(server), record: server });
        }
        server = { ...record, rev: baseRev + 1 };
        putBodies.push(server);
        return res(200, { ok: true, rev: server.rev });
    }

    return res(405, { error: '허용되지 않는 요청' });
}

const sut = {};
eval(dataLayer + `
    sut.loadData = loadData;
    sut.saveData = saveData;
    sut.rollbackMessage = rollbackMessage;
    sut.endpoint = () => DATA_ENDPOINT;
    sut.getDb = () => db;
    sut.rewindClock = ms => { dataLoadedAt = Math.max(0, dataLoadedAt - ms); };
`);

/* ---------- 검사 ---------- */
const results = [];
const check = (name, cond) => results.push([name, !!cond]);

/* ---------- 정적 검사: 호출부가 결과를 확인하는가 ---------- */
const bare = html.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*await loadData\(/.test(line));
check('불러오기 결과를 확인하지 않는 호출부가 없음' +
    (bare.length ? ` (${bare.map(b => b[0] + '줄').join(', ')})` : ''), bare.length === 0);

(async () => {
    /* ── 실제로 일어난 일 재현 ── */
    server = { rev: 5, users: { admin: {}, '1': { pi: 10 } }, night: '어제 밤 10시' };
    check('정상 로드 성공', await sut.loadData() === true);
    const staleScreen = sut.getDb();                       // 밤 10시에 켜 둔 화면

    // 밤새 다른 기기들이 활동해서 서버 내용이 완전히 달라짐
    server = { rev: 42, users: { admin: {}, '1': { pi: 99 } }, night: '밤사이 9시간치 기록' };

    // (가) 아침에 그 화면이 그대로 남아 있고, 불러오기가 실패한 경우
    netUp = false; alerts = [];
    check('연결 실패 시 loadData 가 false 를 돌려줌', await sut.loadData({ silent: true }) === false);
    check('실패해도 화면의 db 는 예전 값 그대로', sut.getDb() === staleScreen);
    netUp = true;

    let before = JSON.stringify(server);
    check('[가] 오래된 화면의 저장을 거부', await sut.saveData() === false);
    check('[가] 밤사이 기록이 그대로 보존됨', JSON.stringify(server) === before);
    check('[가] 사용자에게 안내 표시', alerts.length > 0);

    // (나) 불러오기는 됐지만, 화면을 한참 켜 둔 사이 다른 기기가 먼저 저장한 경우
    server = { rev: 50, users: { admin: {}, '1': { pi: 1 } }, note: 'v50' };
    check('로드 성공', await sut.loadData() === true);
    sut.rewindClock(60 * 1000);                            // 1분 전에 읽은 것으로 취급
    server = { rev: 51, users: { admin: {}, '1': { pi: 7 } }, note: '그 사이 다른 기기가 저장' };
    before = JSON.stringify(server); alerts = [];
    check('[나] 판번호가 다르면 저장을 거부', await sut.saveData() === false);
    check('[나] 다른 기기의 기록이 보존됨', JSON.stringify(server) === before);
    check('[나] 사용자에게 안내 표시', alerts.some(a => a.includes('다른 기기')));

    /* ── 정상 동작은 그대로여야 함 ── */
    check('재로드 성공', await sut.loadData() === true);
    sut.getDb().users['1'].pi = 123;
    check('정상 저장 성공', await sut.saveData() === true);
    check('서버에 반영됨', server.users['1'].pi === 123);
    check('판번호가 1 올라감', server.rev === 52);
    check('건드리지 않은 내용은 유지', server.note === '그 사이 다른 기기가 저장');

    sut.getDb().users['1'].pi = 124;
    check('연속 저장도 성공 (같은 학생의 이어지는 동작)', await sut.saveData() === true && server.rev === 53);

    // 되돌린 내용이 또 사라졌을 때 누가 덮어썼는지 알 수 있어야 함
    check('저장 흔적(lastSave)이 남음', !!server.lastSave && !!server.lastSave.at);
    check('저장 흔적에 코드 버전이 들어감', /^\d{4}-\d{2}-\d{2}/.test(server.lastSave.v || ''));

    /* ── 일시적 오류는 재시도로 넘김 ── */
    failGets = 2; alerts = [];
    check('일시적 오류 2번은 재시도로 성공', await sut.loadData() === true);
    check('재시도 중에는 알림을 띄우지 않음', alerts.length === 0);

    /* ── 이상한 응답을 초기값으로 덮어쓰지 않음 ── */
    server = { rev: 60, important: '학급 기록' };
    check('users 가 없는 응답은 로드 실패로 처리', await sut.loadData({ silent: true }) === false);
    check('초기값으로 덮어쓰지 않음', server.important === '학급 기록' && server.users === undefined);
    check('그 뒤 저장도 거부', await sut.saveData() === false && server.important === '학급 기록');

    /* ── 되돌림 감지: 판번호가 뒤로 가면 알아채야 함 ── */
    check('판번호가 뒤로 가면 되돌림으로 감지',
        /되돌아갔습니다/.test(sut.rollbackMessage(53, { rev: 5 }) || ''));
    check('판번호 없는 예전 데이터로 덮어써도 감지',
        /되돌아갔습니다/.test(sut.rollbackMessage(53, { users: {} }) || ''));
    check('정상적으로 올라갈 때는 오탐 없음', sut.rollbackMessage(53, { rev: 54 }) === null);
    check('복구 도구로 되살린 경우도 오탐 없음', sut.rollbackMessage(53, { rev: 60 }) === null);
    check('처음 접속(기록 없음)은 오탐 없음', sut.rollbackMessage(0, { rev: 5 }) === null);

    /* ── 서버 함수(/api/data) 경유: 구조적 방어 ── */
    check('저장소가 아니라 서버 함수를 거쳐서 통신함', sut.endpoint() === '/api/data');

    server = { rev: 100, users: { admin: {}, '1': { pi: 1 } }, note: '최신' };
    check('서버 함수로 로드 성공', await sut.loadData() === true);

    // 화면은 rev 100 을 들고 있는데, 그 사이 다른 기기가 저장해 서버는 101 이 됨
    server = { rev: 101, users: { admin: {}, '1': { pi: 2 } }, note: '다른 기기가 저장' };
    let keep = JSON.stringify(server);
    alerts = [];
    check('서버가 판번호 불일치를 거부(409) → 저장 실패', await sut.saveData() === false);
    check('서버 내용이 덮어쓰이지 않음', JSON.stringify(server) === keep);
    check('충돌 안내 표시', alerts.some(a => a.includes('다른 기기')));

    // 시간 검사를 건너뛰는 짧은 간격에서도 서버가 막아 주는지 (직접 접속 방식의 빈틈이 메워짐)
    check('다시 로드', await sut.loadData() === true);
    server = { ...server, rev: 202, note: '또 다른 기기가 저장' };
    keep = JSON.stringify(server);
    check('10초 이내 저장이어도 서버가 막음', await sut.saveData() === false);
    check('그래도 서버 내용 그대로', JSON.stringify(server) === keep);

    /* ── 서버 설정이 아직 안 됐을 때: 조용히 실패하지 말고 무엇을 할지 알려줘야 함 ── */
    serverFnUp = false;
    alerts = [];
    check('서버 설정이 없으면 로드 실패', await sut.loadData() === false);
    check('무엇을 해야 하는지 알려줌', alerts.some(a => a.includes('JSONBIN_KEY') || a.includes('Cloudflare')));
    check('설정이 없으면 저장도 하지 않음', await sut.saveData() === false);
    serverFnUp = true;

    /* ── 화면 코드에 저장소 열쇠가 남아 있지 않아야 함 ── */
    check('index.html 에 Master Key 없음', !/\$2a\$10\$/.test(html));
    check('index.html 이 저장소에 직접 접속하지 않음', !/api\.jsonbin\.io/.test(html));
    check('index.html 에 X-Master-Key 헤더 없음', !/X-Master-Key/.test(html));

    /* ── 진짜 빈 저장소만 초기화 ── */
    server = {};
    check('완전히 빈 저장소는 초기 데이터 생성', await sut.loadData() === true && !!server.users);

    /* ---------- 결과 ---------- */
    console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
    const failed = results.filter(r => !r[1]).length;
    console.log(failed === 0
        ? `\n전부 통과 (${results.length}개)\n`
        : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
