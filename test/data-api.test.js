/*
 * 서버 함수(/api/data) 테스트
 *
 * 실행:  node test/data-api.test.js
 *
 * functions/api/data.js 를 그대로 불러와, 저장소와 네트워크를 흉내 낸 환경에서 돌립니다.
 * 진짜 저장소에는 접속하지 않습니다.
 *
 * 확인하는 것: 오래된 화면의 저장을 서버가 확실히 막는가, 위험한 저장을 거부하는가,
 * 점검 주소가 학생 정보를 흘리지 않는가
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'functions', 'api', 'data.js');
// 사이트를 닫아 둔 상태여도 나머지 동작은 열린 상태로 확인한다. 닫힌 상태는 따로 확인
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ygfn-'));
const SRC_TEXT = fs.readFileSync(SRC, 'utf8');
const CLOSED_FLAG = /const SITE_ACCESS = "(open|admin|closed)";/;
const tmp = path.join(TMPDIR, 'data.mjs');
const tmpClosed = path.join(TMPDIR, 'data-closed.mjs');
const tmpAdmin = path.join(TMPDIR, 'data-admin.mjs');
fs.writeFileSync(tmp, SRC_TEXT.replace(CLOSED_FLAG, 'const SITE_ACCESS = "open";'));
fs.writeFileSync(tmpClosed, SRC_TEXT.replace(CLOSED_FLAG, 'const SITE_ACCESS = "closed";'));
fs.writeFileSync(tmpAdmin, SRC_TEXT.replace(CLOSED_FLAG, 'const SITE_ACCESS = "admin";'));

// Cloudflare KV 를 흉내 낸 저장공간
function makeKV() {
    const store = new Map();
    return {
        store,
        async get(k, o) { const v = store.get(k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
        async put(k, v) { store.set(k, v); },
        async delete(k) { store.delete(k); }
    };
}
// Cloudflare D1 을 흉내 낸 데이터베이스.
// 이 파일이 실제로 보내는 문장만 알아듣습니다 (진짜 SQL 엔진이 아님).
function makeD1() {
    const self = {
        state: undefined,            // { rev, record, updated_at }
        backups: new Map(),          // date -> { record, rev, users, at }
        audit: [],                   // 활동 기록 줄
        record() { return JSON.parse(self.state.record); },
        setRaw(rev, obj) { self.state = { rev, record: JSON.stringify(obj), updated_at: 'x' }; },
        // 다음 번 '읽기' 직후에 딱 한 번 끼어들어 저장을 바꿔치기 (동시 저장 흉내)
        raceOnce(fn) { pending = fn; },
        get tablesMade() { return ['state', 'backups'].filter(t => made.has(t)).length; },
        settings: new Map(),
        // '몇 줄이 바뀌었는지' 를 아예 안 알려주는 데이터베이스 흉내
        hideChanges() { silent = true; }
    };
    let pending = null;
    const made = new Set();
    let silent = false;
    const run = async (sql, args) => {
        const create = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
        if (create) { made.add(create[1]); return { meta: { changes: 0 } }; }
        const table = (sql.match(/(?:FROM|INTO|UPDATE) (\w+)/) || [])[1];
        if (table === 'settings' || table === 'audit') {
            if (!made.has(table)) throw new Error(table + ' 표를 만들기 전에 접근했어요');
        } else if (!(made.has('state') && made.has('backups'))) throw new Error('표를 만들기 전에 접근했어요');
        if (/^SELECT value FROM settings/.test(sql)) {
            const key = sql.match(/key = '(\w+)'/)[1];
            return { first: self.settings.has(key) ? { value: self.settings.get(key) } : null };
        }
        if (/^INSERT INTO settings/.test(sql)) {
            const key = sql.match(/VALUES \('(\w+)'/)[1];
            self.settings.set(key, args[0]);
            return { meta: { changes: 1 } };
        }

        if (/^SELECT rev, record FROM state/.test(sql)) {
            const row = self.state ? { rev: self.state.rev, record: self.state.record } : null;
            if (pending) { const f = pending; pending = null; f(); }
            return { first: row };
        }
        if (/^INSERT INTO state/.test(sql)) {
            const [rev, record, at] = args;
            const cas = /WHERE state\.rev = \?4/.test(sql);
            if (self.state && cas && self.state.rev !== args[3]) return { meta: silent ? {} : { changes: 0 } };
            self.state = { rev, record, updated_at: at };
            return { meta: silent ? {} : { changes: 1 } };
        }
        if (/^INSERT OR IGNORE INTO backups/.test(sql)) {
            const [date, record, rev, users, at] = args;
            if (self.backups.has(date)) return { meta: { changes: 0 } };
            self.backups.set(date, { record, rev, users, at });
            return { meta: { changes: 1 } };
        }
        if (/^DELETE FROM backups/.test(sql)) {
            const keep = [...self.backups.keys()].sort().reverse().slice(0, args[0]);
            for (const d of [...self.backups.keys()]) if (!keep.includes(d)) self.backups.delete(d);
            return { meta: { changes: 1 } };
        }
        if (/^SELECT date, at, rev, users FROM backups/.test(sql)) {
            const rows = [...self.backups.entries()]
                .sort((a, b) => (a[0] < b[0] ? 1 : -1))
                .map(([date, b]) => ({ date, at: b.at, rev: b.rev, users: b.users }));
            return { all: rows };
        }
        if (/^SELECT record FROM backups WHERE date/.test(sql)) {
            const b = self.backups.get(args[0]);
            return { first: b ? { record: b.record } : null };
        }
        if (/^INSERT INTO audit/.test(sql)) {
            const [at, kind, account, name, ip, device, ua, detail] = args;
            self.audit.push({ id: self.audit.length + 1, at, kind, account, name, ip, device, ua, detail });
            return { meta: { changes: 1 } };
        }
        if (/^DELETE FROM audit/.test(sql)) {
            const maxId = self.audit.reduce((m, r) => Math.max(m, r.id), 0);
            self.audit = self.audit.filter(r => !(r.at < args[0] || r.id <= maxId - args[1]));
            return { meta: { changes: 1 } };
        }
        if (/^SELECT id, at, kind, account, name, ip, device, ua, detail FROM audit/.test(sql)) {
            const byAccount = /WHERE account = \?1/.test(sql);
            const rows = self.audit.filter(r => !byAccount || r.account === args[0]).slice().reverse();
            return { all: rows.slice(0, byAccount ? args[1] : args[0]) };
        }
        throw new Error('가짜 D1 이 모르는 문장: ' + sql);
    };
    self.db = {
        prepare(sql) {
            let args = [];
            const stmt = {
                bind(...a) { args = a; return stmt; },
                async run() { return run(sql, args); },
                async first() { return (await run(sql, args)).first; },
                async all() { return { results: (await run(sql, args)).all || [] }; }
            };
            return stmt;
        }
    };
    return self;
}

let KV = makeKV();
const ENV = { JSONBIN_BIN_ID: 'bin123', JSONBIN_KEY: 'secret-key', get BACKUPS() { return KV; } };

let storage = null;      // 저장소에 들어 있다고 가정하는 내용
var versionStore = {};   // 버전 번호 -> 내용
let storageUp = true;
let versionsStatus = 200;   // 저장소가 버전 목록에 주는 응답
let sentKeys = [];       // 저장소로 나간 요청의 열쇠 (서버만 알고 있어야 함)

global.fetch = async (url, opts = {}) => {
    sentKeys.push(opts.headers && opts.headers['X-Master-Key']);
    if (!storageUp) return { ok: false, status: 500, json: async () => ({}) };
    const u = String(url);
    const method = opts.method || 'GET';
    if (method === 'GET' && u.endsWith('/latest')) {
        return { ok: true, status: 200, json: async () => ({ record: JSON.parse(JSON.stringify(storage)) }) };
    }
    if (method === 'GET' && u.endsWith('/versions')) {
        if (versionsStatus !== 200) return { ok: false, status: versionsStatus, json: async () => ({}) };
        const list = Object.keys(versionStore).map((v, i) => ({ id: Number(v), createdAt: `2026-09-1${i + 5}T00:00:00Z` }));
        return { ok: true, status: 200, json: async () => ({ record: { versions: list } }) };
    }
    if (method === 'GET') {
        const v = u.split('/').pop();
        if (!(v in versionStore)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ record: JSON.parse(JSON.stringify(versionStore[v])) }) };
    }
    if (method === 'PUT') { storage = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: false, status: 405, json: async () => ({}) };
};

const backupIndexKey = 'backup:index';
const req = (method, query = '', body = null, headers = {}) => new Request(`https://example.pages.dev/api/data${query}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }
});

const SITE_CLOSED_TEXT = src => (src.match(/SITE_CLOSED_MESSAGE = "([^"]*)"/) || [])[1] || '';
const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
    const { onRequest } = await import('file://' + tmp);
    const call = async (method, query, body, env = ENV) => {
        const res = await onRequest({ request: req(method, query, body), env });
        return { status: res.status, body: await res.json() };
    };

    /* ── 환경 변수가 없을 때: 왜 안 보이는지 짚어 줘야 함 ── */
    let r = await call('GET', '?check=1', null, {});
    check('환경 변수 없으면 503', r.status === 503);
    check('무엇이 빠졌는지 알려줌', Array.isArray(r.body.missing) && r.body.missing.length === 2);
    check('하나도 없으면 그렇게 안내', /하나도 없어요/.test(r.body.hint));

    // 이름을 잘못 적은 경우 → 그 이름을 그대로 보여줘야 함
    r = await call('GET', '?check=1', null, { JSONBIN_BIN_ID: 'bin123', JSONBIN_API_KEY: 'x' });
    check('철자 틀린 이름을 찾아냄', r.body.similarNames.includes('JSONBIN_API_KEY'));
    check('철자 확인을 안내', /철자/.test(r.body.hint));
    check('빠진 것은 KEY 하나로 보고', r.body.missing.length === 1 && r.body.missing[0] === 'JSONBIN_KEY');

    // 이름은 맞는데 값이 비어 있는 경우
    r = await call('GET', '?check=1', null, { JSONBIN_BIN_ID: 'bin123', JSONBIN_KEY: '' });
    check('값이 비었음을 구분해서 알려줌', r.body.emptyValue.includes('JSONBIN_KEY') && /값이 비어/.test(r.body.hint));

    // 값도 이름도 정상인데 KEY 만 아예 없는 경우 → 재배포 안내
    r = await call('GET', '?check=1', null, { JSONBIN_BIN_ID: 'bin123', GEMINI_API_KEY: 'g' });
    check('그 밖에는 재배포를 안내', /재배포/.test(r.body.hint));
    check('관계없는 비밀 이름은 보여주지 않음', !r.body.similarNames.includes('GEMINI_API_KEY'));
    check('환경 변수 값은 어떤 경우에도 돌려주지 않음', !JSON.stringify(r.body).includes('bin123'));

    /* ── 점검 주소 ── */
    storage = { rev: 10, users: { admin: { password: '비밀번호', name: '관리자' }, '1': { pi: 5, password: '1' } }, lastSave: { by: '관리자' } };
    r = await call('GET', '?check=1');
    check('점검 주소 정상 응답', r.status === 200 && r.body.ok === true);
    check('점검 주소가 판번호·인원을 알려줌', r.body.rev === 10 && r.body.users === 2);
    check('점검 주소가 학생 정보를 흘리지 않음', !JSON.stringify(r.body).includes('비밀번호'));

    /* ── 예전 버전이 남아 있는지 알려주기 (되살릴 수 있는지 판단) ── */
    versionStore[3] = { rev: 3, users: { admin: {} } };
    versionStore[4] = { rev: 4, users: { admin: {} } };
    r = await call('GET', '?check=1');
    check('버전이 있으면 개수를 알려줌', r.body.versions.available === true && r.body.versions.count === 2);
    check('가장 오래된/최근 시각을 알려줌', !!r.body.versions.oldest && !!r.body.versions.newest);
    check('되살릴 수 있다고 안내', /restore\.html/.test(r.body.versions.hint));

    versionsStatus = 403;   // 요금제에서 지원하지 않거나 꺼져 있는 경우
    r = await call('GET', '?check=1');
    check('버전을 쓸 수 없으면 그렇게 알려줌', r.body.versions.available === false && r.body.versions.reason === 'HTTP 403');
    check('대신 쓸 방법을 안내', /빨간 띠/.test(r.body.versions.hint));
    check('버전을 못 읽어도 연결 자체는 정상으로 봄', r.body.ok === true);
    versionsStatus = 200;

    const savedVersions = { ...versionStore };
    versionStore = {};
    r = await call('GET', '?check=1');
    check('보관된 버전이 하나도 없으면 그렇게 알려줌', r.body.versions.available === false && /없어요/.test(r.body.versions.reason));
    versionStore = savedVersions;

    /* ── 읽기 ── */
    r = await call('GET', '');
    check('읽기 성공', r.status === 200 && r.body.rev === 10 && !!r.body.record.users);

    /* ── 저장: 판번호가 맞을 때만 ──
       (lastSave.build 는 화면 버전. 이게 없거나 낮으면 아래 '예전 화면 차단' 에서 거부된다) */
    const good = { users: { admin: {}, '1': { pi: 6 } }, note: '새 내용', lastSave: { build: 32 } };
    r = await call('PUT', '', { baseRev: 10, record: good });
    check('판번호가 맞으면 저장됨', r.status === 200 && r.body.rev === 11);
    check('저장소에 반영되고 판번호가 올라감', storage.rev === 11 && storage.note === '새 내용');

    const before = JSON.stringify(storage);
    r = await call('PUT', '', { baseRev: 10, record: { users: { admin: {} }, note: '오래된 화면', lastSave: { build: 32 } } });
    check('오래된 판번호로 저장하면 409', r.status === 409);
    check('409 일 때 저장소가 바뀌지 않음', JSON.stringify(storage) === before);
    check('409 가 최신 내용을 함께 돌려줌', r.body.rev === 11 && !!r.body.record);

    r = await call('PUT', '', { baseRev: 11, record: { note: '학생 정보 없음', lastSave: { build: 32 } } });
    check('학생 정보 없는 저장은 400 으로 거부', r.status === 400);
    check('거부 후 저장소 그대로', JSON.stringify(storage) === before);

    r = await call('PUT', '', { record: good });
    check('baseRev 없으면 400', r.status === 400);

    /* ── 되돌리기: 관리자 비밀번호 필요 ── */
    storage = { rev: 50, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    versionStore[7] = { rev: 20, users: { admin: { password: 'pw!' }, '1': { pi: 99 } }, note: '되살릴 내용' };

    r = await call('POST', '', { restoreVersion: 7, password: '틀린비번' });
    check('비밀번호 틀리면 403', r.status === 403);
    check('403 이면 저장소 그대로', storage.rev === 50);

    /* ── 데이터가 예전으로 돌아갔을 때 쓰는 복구 비밀번호 ── */
    r = await call('POST', '', { restoreVersion: 7, password: '2323' });
    check('복구 비밀번호로도 되돌릴 수 있음', r.status === 200 && storage.users['1'].pi === 99);

    storage = { rev: 60, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    r = await call('POST', '', { restoreVersion: 7, password: '' });
    check('빈 비밀번호는 거부', r.status === 403 && storage.rev === 60);
    r = await call('POST', '', { restoreVersion: 7 });
    check('비밀번호가 없으면 거부', r.status === 403 && storage.rev === 60);
    r = await call('POST', '', { restoreVersion: 7, password: 232 });
    check('숫자로 보내도 거부 (문자열만)', r.status === 403 && storage.rev === 60);

    // 환경 변수로 복구 비밀번호를 바꿀 수 있어야 함
    const ENV2 = { ...ENV, RECOVERY_PASSWORD: '9999' };
    r = await call('POST', '', { restoreVersion: 7, password: '9999' }, ENV2);
    check('환경 변수로 정한 복구 비밀번호가 통함', r.status === 200);

    storage = { rev: 70, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    r = await call('POST', '', { restoreVersion: 7, password: '2323' }, ENV2);
    check('환경 변수를 정하면 기본 복구 비밀번호는 막힘', r.status === 403 && storage.rev === 70);
    r = await call('POST', '', { restoreVersion: 7, password: 'pw!' }, ENV2);
    check('그때도 관리자 비밀번호는 통함', r.status === 200);

    // 복구 비밀번호는 저장(PUT)에는 쓸 수 없어야 함
    storage = { rev: 80, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    r = await call('PUT', '', { baseRev: 80, record: { users: { admin: {} }, password: '2323' } });
    check('복구 비밀번호가 일반 저장을 열어 주지는 않음', r.status === 426 && storage.rev === 80);

    storage = { rev: 50, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };

    r = await call('POST', '', { restoreVersion: 7, password: 'pw!' });
    check('비밀번호 맞으면 되돌아감', r.status === 200 && storage.users['1'].pi === 99);
    check('판번호는 이전 최고값 위로 올라감', storage.rev === 51);
    check('어느 버전에서 되살렸는지 남음', storage.restoredFrom === 7);

    /* ── 예전 화면의 저장을 막는가 ──
       기기마다 다른 버전이 돌면 예전 버전이 주가 기록을 되돌려 놓아, 그래프가
       계속 1시간치에서 멈춥니다. 서버에서 막아야 모든 기기가 같은 버전으로 모입니다. */
    storage = { rev: 200, users: { admin: {}, '1': { pi: 1 } }, note: '지켜야 할 내용' };
    const keepStorage = JSON.stringify(storage);
    const withBuild = b => ({ users: { admin: {}, '1': { pi: 2 } }, lastSave: { at: 'x', by: 'y', v: 'z', build: b } });

    r = await call('PUT', '', { baseRev: 200, record: withBuild(6) });
    check('예전 빌드(6)의 저장은 426 으로 거부', r.status === 426 && r.body.error === 'outdated');
    check('거부하면 저장소가 그대로', JSON.stringify(storage) === keepStorage);
    check('어느 버전이 필요한지 알려줌', r.body.needBuild >= 7 && r.body.gotBuild === 6);

    r = await call('PUT', '', { baseRev: 200, record: { users: { admin: {} } } });
    check('빌드 번호가 아예 없으면 거부', r.status === 426 && r.body.gotBuild === null);
    check('그때도 저장소 그대로', JSON.stringify(storage) === keepStorage);

    r = await call('PUT', '', { baseRev: 200, record: withBuild(32) });
    check('현재 빌드(32)의 저장은 통과', r.status === 200 && storage.users['1'].pi === 2);

    storage = { rev: 300, users: { admin: {}, '1': { pi: 3 } } };
    r = await call('PUT', '', { baseRev: 300, record: withBuild(99) });
    check('더 새로운 빌드도 통과', r.status === 200 && storage.users['1'].pi === 2);

    /* ── 백업 파일로 되돌리기 (버전 보관이 없는 요금제용) ── */
    storage = { rev: 60, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    const backup = { rev: 55, users: { admin: { password: 'pw!' }, '1': { pi: 777 } }, note: '내려받아 둔 백업' };

    r = await call('POST', '', { record: backup, password: '틀린비번' });
    check('파일 되돌리기도 비밀번호 확인', r.status === 403 && storage.users['1'].pi === 1);

    r = await call('POST', '', { record: { note: '학생 정보 없는 파일' }, password: 'pw!' });
    check('학생 정보 없는 파일은 거부', r.status === 400 && storage.users['1'].pi === 1);

    r = await call('POST', '', { record: backup, password: 'pw!' });
    check('백업 파일로 되돌아감', r.status === 200 && storage.users['1'].pi === 777);
    check('파일 되돌리기도 판번호가 올라감', storage.rev === 61);
    check('백업 파일에서 왔다고 남음', storage.restoredFrom === '백업 파일' && !!storage.restoredAt);

    r = await call('POST', '', { password: 'pw!' });
    check('버전도 파일도 없으면 400', r.status === 400);

    storage = { rev: 50, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    versionStore[8] = { rev: 21, note: '학생 정보 없는 버전' };
    const keep = JSON.stringify(storage);
    r = await call('POST', '', { restoreVersion: 8, password: 'pw!' });
    check('학생 정보 없는 버전으로는 되돌리지 않음', r.status === 400 && JSON.stringify(storage) === keep);

    /* ── 자동 백업: 아무도 아무것도 누르지 않아도 사본이 남아야 함 ── */
    KV = makeKV();
    storage = { rev: 100, users: { admin: { password: 'pw!' }, '1': { pi: 10 } }, note: '오늘 내용' };
    r = await call('GET', '?check=1');
    check('백업이 아직 없으면 그렇게 알려줌', r.body.backups.available === true && r.body.backups.count === 0);

    r = await call('PUT', '', { baseRev: 100, record: { users: { admin: { password: 'pw!' }, '1': { pi: 11 } }, note: '첫 저장', lastSave: { build: 32 } } });
    check('저장하면 자동으로 사본이 남음', r.status === 200 && KV.store.size === 2);

    r = await call('GET', '?check=1');
    check('백업 목록에 오늘 날짜가 있음', r.body.backups.count === 1 && /^\d{4}-\d{2}-\d{2}$/.test(r.body.backups.dates[0]));

    const kvSizeAfterFirst = KV.store.size;
    r = await call('PUT', '', { baseRev: 101, record: { users: { admin: { password: 'pw!' }, '1': { pi: 12 } }, lastSave: { build: 32 } } });
    check('같은 날 또 저장해도 사본은 하나 (저장 횟수 아낌)', KV.store.size === kvSizeAfterFirst);

    // 백업에서 되돌리기
    const today = r.body ? null : null;
    const idx = await KV.get(backupIndexKey, { type: 'json' });
    const backupDate = idx[0].date;
    storage = { rev: 500, users: { admin: { password: 'pw!' }, '1': { pi: 999 } }, note: '망가진 상태' };

    r = await call('POST', '', { restoreBackup: backupDate, password: '틀린비번' });
    check('백업 되돌리기도 비밀번호 확인', r.status === 403 && storage.note === '망가진 상태');

    r = await call('POST', '', { restoreBackup: backupDate, password: '2323' });
    check('복구 비밀번호로 백업에서 되돌림', r.status === 200 && storage.note === '첫 저장');
    check('되돌린 뒤 판번호가 더 커짐', storage.rev > 500);
    check('어디서 왔는지 남음', String(storage.restoredFrom).includes(backupDate));

    r = await call('GET', '?backup=' + backupDate);
    check('KV 백업도 날짜별로 내려받을 수 있음', r.status === 200 && r.body.record.note === '첫 저장');

    r = await call('POST', '', { restoreBackup: '2020-01-01', password: '2323' });
    check('없는 날짜는 404', r.status === 404);
    r = await call('POST', '', { restoreBackup: '엉터리', password: '2323' });
    check('날짜 형식이 아니면 400', r.status === 400);

    // KV 가 없어도 사이트는 동작해야 함
    const savedKV = KV;
    KV = null;
    storage = { rev: 900, users: { admin: {}, '1': { pi: 1 } } };
    r = await call('PUT', '', { baseRev: 900, record: { users: { admin: {} }, note: 'KV 없음', lastSave: { build: 32 } } });
    check('백업이 꺼져 있어도 저장은 정상', r.status === 200 && storage.note === 'KV 없음');
    r = await call('GET', '?check=1');
    check('백업이 꺼져 있으면 설정 방법을 안내', r.body.backups.available === false && /D1/.test(r.body.backups.hint));
    r = await call('POST', '', { restoreBackup: '2026-09-17', password: '2323' });
    check('백업이 꺼져 있으면 되돌리기도 막음', r.status === 400);
    r = await call('GET', '?backup=2026-09-17');
    check('백업이 꺼져 있으면 내려받기도 막음', r.status === 400);
    KV = savedKV;

    /* ── 그 밖 ── */
    r = await call('DELETE', '');
    check('허용하지 않는 방식은 405', r.status === 405);

    storageUp = false;
    r = await call('GET', '?check=1');
    check('저장소 연결 실패는 502 로 알려줌', r.status === 502 && r.body.ok === false);
    storageUp = true;

    check('열쇠는 서버에서만 쓰임', sentKeys.length > 0 && sentKeys.every(k => k === ENV.JSONBIN_KEY));

    /* ── 데이터베이스가 '몇 줄 바뀌었는지' 를 안 알려줘도 안전해야 함 ──
       이때 '저장됐다' 고 믿어 버리면, 학생은 저장된 줄 알지만 실제로는 사라집니다.
       그래서 모를 때는 반드시 다시 읽어서 확인합니다. */
    const QUIET = makeD1();
    const QUIETENV = { get DB() { return QUIET.db; } };
    QUIET.hideChanges();
    const qrec = (pi) => ({ users: { admin: { password: 'pw!' }, '1': { pi } }, lastSave: { build: 32 } });

    r = await call('PUT', '', { baseRev: 0, record: qrec(1) }, QUIETENV);
    check('D1(조용): 진짜 저장됐으면 성공으로 답함', r.status === 200 && QUIET.record().users['1'].pi === 1);

    QUIET.raceOnce(() => { QUIET.setRaw(9, { users: { admin: {}, '1': { pi: 555 } }, rev: 9 }); });
    r = await call('PUT', '', { baseRev: 1, record: qrec(2) }, QUIETENV);
    check('D1(조용): 안 들어갔으면 성공이라고 하지 않음', r.status === 409);
    check('D1(조용): 끼어든 쪽 내용이 그대로', QUIET.record().users['1'].pi === 555);

    /* ══════════════════ Cloudflare D1 저장소 ══════════════════
       D1 은 '판번호가 그대로일 때만 저장' 을 데이터베이스가 직접 보장합니다.
       아래 가짜 D1 은 이 파일이 실제로 보내는 문장만 흉내 냅니다 (진짜 SQLite 가 아님).
       그래서 확인하는 것은 'SQL 이 맞는가' 가 아니라 '우리 코드가 판번호를 제대로 다루는가' 입니다. */
    const D1 = makeD1();
    const D1ENV = { get DB() { return D1.db; }, RECOVERY_PASSWORD: undefined };

    // 처음 열었을 때: 저장소가 비어 있으면 화면이 처음 자료를 만들 수 있도록 {} 를 준다
    r = await call('GET', '', null, D1ENV);
    check('D1: 비어 있으면 빈 내용을 돌려줌', r.status === 200 && Object.keys(r.body.record).length === 0 && r.body.rev === 0);
    check('D1: 표를 알아서 만듦', D1.tablesMade === 2);

    const rec = (pi, build = 32) => ({ users: { admin: { password: 'pw!' }, '1': { pi } }, lastSave: { build } });

    r = await call('PUT', '', { baseRev: 0, record: rec(10) }, D1ENV);
    check('D1: 첫 저장이 들어감', r.status === 200 && r.body.rev === 1 && D1.record().users['1'].pi === 10);
    check('D1: 저장하면 사본이 남음', D1.backups.size === 1);

    r = await call('GET', '', null, D1ENV);
    check('D1: 저장한 내용을 그대로 읽음', r.body.rev === 1 && r.body.record.users['1'].pi === 10);

    r = await call('PUT', '', { baseRev: 1, record: rec(11) }, D1ENV);
    check('D1: 판번호가 맞으면 저장', r.status === 200 && r.body.rev === 2 && D1.record().users['1'].pi === 11);

    // 오래된 화면이 통째로 덮어쓰려는 경우 — 읽을 때 이미 판번호가 달라 막힌다
    r = await call('PUT', '', { baseRev: 1, record: rec(99) }, D1ENV);
    check('D1: 오래된 판번호는 409 로 거부', r.status === 409 && r.body.rev === 2);
    check('D1: 거부된 저장은 저장소를 건드리지 않음', D1.record().users['1'].pi === 11);
    check('D1: 409 는 최신 내용을 함께 돌려줌', r.body.record.users['1'].pi === 11);

    // 핵심: '읽은 순간' 과 '쓰는 순간' 사이에 누가 끼어든 경우.
    // jsonbin 에서는 이 틈으로 덮어쓰기가 일어났고, D1 에서는 데이터베이스가 막는다
    D1.raceOnce(() => { D1.setRaw(5, { users: { admin: {}, '1': { pi: 777 } }, rev: 5 }); });
    r = await call('PUT', '', { baseRev: 2, record: rec(12) }, D1ENV);
    check('D1: 읽기와 쓰기 사이에 끼어든 저장도 막음', r.status === 409);
    check('D1: 끼어든 쪽 내용이 그대로 남음', D1.record().users['1'].pi === 777 && D1.state.rev === 5);
    check('D1: 그때도 최신 판번호를 알려줌', r.body.rev === 5);

    // 예전 화면 차단은 D1 에서도 그대로
    const beforeBuild = JSON.stringify(D1.state);
    r = await call('PUT', '', { baseRev: 5, record: rec(1, 31) }, D1ENV);
    check('D1: 예전 빌드는 426 으로 거부', r.status === 426 && r.body.needBuild === 32);
    check('D1: 그때도 저장소 그대로', JSON.stringify(D1.state) === beforeBuild);

    r = await call('PUT', '', { baseRev: 5, record: { note: '학생 정보 없음', lastSave: { build: 32 } } }, D1ENV);
    check('D1: 학생 정보 없는 저장은 거부', r.status === 400 && JSON.stringify(D1.state) === beforeBuild);

    /* ── D1 자동 백업 ── */
    r = await call('PUT', '', { baseRev: 5, record: rec(20) }, D1ENV);
    check('D1: 판번호가 맞으면 계속 저장됨', r.status === 200 && r.body.rev === 6);
    const d1Date = [...D1.backups.keys()][0];
    check('D1: 사본 이름이 날짜', /^\d{4}-\d{2}-\d{2}$/.test(d1Date));
    check('D1: 같은 날 여러 번 저장해도 사본은 하나 (그날 처음 저장한 내용)',
        D1.backups.size === 1 && JSON.parse(D1.backups.get(d1Date).record).users['1'].pi === 10);

    r = await call('GET', '?backups=1', null, D1ENV);
    check('D1: 백업 목록을 D1 에서 읽음', r.body.available === true && r.body.where === 'D1' && r.body.dates[0] === d1Date);
    check('D1: 날짜마다 학생 수·판번호를 함께 알려줌',
        Array.isArray(r.body.entries) && r.body.entries[0].date === d1Date && r.body.entries[0].users === 2);

    // 되돌리기 전에 내용을 확인하거나 파일로 받아 두는 길 (아무것도 바꾸지 않아야 함)
    const beforeView = JSON.stringify(D1.state);
    r = await call('GET', '?backup=' + d1Date, null, D1ENV);
    check('D1: 날짜별 백업 내용을 그대로 돌려줌', r.status === 200 && r.body.record.users['1'].pi === 10 && r.body.date === d1Date);
    check('D1: 내용 보기는 지금 데이터를 건드리지 않음', JSON.stringify(D1.state) === beforeView);

    r = await call('GET', '?backup=2020-01-01', null, D1ENV);
    check('D1: 없는 날짜를 내려받으려 하면 404', r.status === 404);
    r = await call('GET', '?backup=엉터리', null, D1ENV);
    check('D1: 날짜 형식이 아니면 400', r.status === 400);
    r = await call('GET', '?backups=1', null, D1ENV);
    check('D1: ?backups 와 ?backup 이 서로 헷갈리지 않음', r.body.available === true && r.body.record === undefined);

    r = await call('POST', '', { restoreBackup: d1Date, password: '틀린비번' }, D1ENV);
    check('D1: 백업 되돌리기도 비밀번호 확인', r.status === 403 && D1.record().users['1'].pi === 20);

    r = await call('POST', '', { restoreBackup: d1Date, password: 'pw!' }, D1ENV);
    check('D1: 관리자 비밀번호로 백업에서 되돌림', r.status === 200 && D1.record().users['1'].pi === 10);
    check('D1: 되돌린 뒤 판번호가 더 커짐', D1.state.rev === 7 && D1.record().rev === 7);
    check('D1: 어디서 왔는지 남음', String(D1.record().restoredFrom).includes(d1Date));

    r = await call('POST', '', { restoreBackup: '2020-01-01', password: '2323' }, D1ENV);
    check('D1: 없는 날짜는 404', r.status === 404);

    // 오래된 사본은 스스로 지워져야 함 (보관 기간 45일).
    // 정리는 '그날의 첫 사본을 남길 때' 한 번만 하므로, 오늘 사본이 아직 없는 저장소로 확인한다
    const OLD = makeD1();
    const OLDENV = { get DB() { return OLD.db; } };
    const oldDates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10));
    oldDates.forEach((d, i) => OLD.backups.set(d, { record: '{}', rev: i }));
    r = await call('PUT', '', { baseRev: 0, record: rec(22) }, OLDENV);
    const oldToday = [...OLD.backups.keys()].sort().pop();
    check('D1: 보관 기간을 넘긴 사본은 지워짐', r.status === 200 && OLD.backups.size === 45);
    check('D1: 오늘 사본은 남고 가장 오래된 것부터 지워짐',
        OLD.backups.has(oldToday) && !OLD.backups.has(oldDates[0]) && OLD.backups.has(oldDates[59]));

    /* ── 점검 주소가 어느 저장소를 쓰는지 알려줘야 함 ── */
    r = await call('GET', '?check=1', null, D1ENV);
    check('D1: 점검 주소 정상', r.status === 200 && r.body.ok === true);
    check('D1: 어느 저장소인지 알려줌', r.body.storage.backend === 'D1' && r.body.storage.d1 === true);
    check('D1: 점검 주소가 학생 정보를 흘리지 않음', !JSON.stringify(r.body).includes('pw!'));
    check('D1: 버전 대신 자동 백업을 안내', r.body.versions.available === false && /자동 백업/.test(r.body.versions.hint));

    r = await call('GET', '?versions=1', null, D1ENV);
    check('D1: 예전 버전 목록은 400 과 함께 안내', r.status === 400 && /자동 백업/.test(r.body.error));
    r = await call('POST', '', { restoreVersion: 3, password: 'pw!' }, D1ENV);
    check('D1: 버전으로 되돌리기도 막고 안내', r.status === 400);

    // jsonbin 을 계속 쓰는 배포는 예전 그대로 동작해야 함
    r = await call('GET', '?check=1');
    check('jsonbin 배포는 그대로 동작', r.status === 200 && r.body.storage.backend === 'jsonbin');

    /* ── 옮겨오기: D1 이 비어 있으면 예전 저장소 내용을 한 번 가져온다 ── */
    const MOVE = makeD1();
    const MOVEENV = { JSONBIN_BIN_ID: 'bin123', JSONBIN_KEY: 'secret-key', get DB() { return MOVE.db; } };
    storage = { rev: 42, users: { admin: { password: 'pw!' }, '1': { pi: 123 }, '2': { pi: 5 } }, note: '예전 저장소 내용' };

    r = await call('GET', '', null, MOVEENV);
    check('옮겨오기: 예전 내용을 그대로 읽어옴', r.body.rev === 42 && r.body.record.note === '예전 저장소 내용');
    check('옮겨오기: D1 에 들어감', MOVE.state && MOVE.state.rev === 42 && MOVE.record().users['2'].pi === 5);

    // 옮긴 뒤로는 D1 만 진짜. 예전 저장소가 바뀌어도 따라가지 않는다
    storage = { rev: 999, users: { admin: {}, '1': { pi: 0 } }, note: '예전 저장소가 나중에 바뀜' };
    r = await call('GET', '', null, MOVEENV);
    check('옮겨오기: 한 번만 하고 그 뒤엔 D1 만 씀', r.body.record.note === '예전 저장소 내용' && r.body.rev === 42);

    r = await call('PUT', '', { baseRev: 42, record: rec(50) }, MOVEENV);
    check('옮겨오기: 이어서 저장됨', r.status === 200 && r.body.rev === 43 && MOVE.record().users['1'].pi === 50);
    check('옮겨오기: 예전 저장소에는 더 쓰지 않음', storage.note === '예전 저장소가 나중에 바뀜');

    r = await call('GET', '?check=1', null, MOVEENV);
    check('옮겨오기: 점검 주소가 옮긴 사실을 알려줌', r.body.storage.d1 === true && r.body.storage.jsonbin === true && !!r.body.storage.note);

    // 학생 정보가 없는 예전 내용은 옮겨오지 않는다 (망가진 내용을 그대로 굳히면 안 됨)
    const BAD = makeD1();
    storage = { note: '학생 정보가 없는 내용' };
    r = await call('GET', '', null, { JSONBIN_BIN_ID: 'bin123', JSONBIN_KEY: 'secret-key', get DB() { return BAD.db; } });
    check('옮겨오기: 학생 정보 없는 내용은 옮기지 않음', Object.keys(r.body.record).length === 0 && BAD.state === undefined);

    /* ── 저장소가 아무것도 없으면 503 ── */
    r = await call('GET', '?check=1', null, {});
    check('저장소가 하나도 없으면 503', r.status === 503 && r.body.d1 === false);
    check('D1 설정 방법을 안내', /D1/.test(r.body.hint) && /DB/.test(r.body.hint));



    /* ── 활동 기록: 누가, 어느 기기에서 돈을 움직였는지 ── */
    {
        const A = makeD1();
        const AENV = { get DB() { return A.db; }, RECOVERY_PASSWORD: undefined };
        const callA = async (method, query, body, headers) => {
            const res = await onRequest({ request: req(method, query, body, headers), env: AENV });
            return { status: res.status, body: await res.json() };
        };
        const users = (p1, p30, pw1 = '1') => ({
            admin: { name: '선생님', password: 'adminpw' },
            '1': { name: '김일', pi: p1, password: pw1 },
            '30': { name: '박삼십', pi: p30, password: '30' }
        });
        const DEV = { 'X-Device-Id': 'dev-aaa', 'X-Account': '1', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'Mozilla/5.0 (iPhone)' };
        await callA('PUT', '', { baseRev: 0, record: { users: users(100, 0), bank: { logs: [] }, lastSave: { build: 32 } } }, DEV);
        const before = A.audit.length;
        r = await callA('PUT', '', { baseRev: 1, record: {
            users: users(80, 20), bank: { logs: [{ id: 'L1', text: '김일 → 박삼십 20π 송금' }] }, lastSave: { build: 32, by: '김일' }
        } }, DEV);
        check('기록: 송금 저장 성공', r.status === 200);
        const row = A.audit[A.audit.length - 1];
        check('기록: 돈이 움직인 저장은 한 줄 남김', A.audit.length === before + 1 && row.kind === 'save');
        check('기록: IP 를 서버가 적음', row.ip === '203.0.113.7');
        check('기록: 기기 번호를 적음', row.device === 'dev-aaa');
        check('기록: 브라우저 종류를 적음', /iPhone/.test(row.ua));
        check('기록: 어느 계정으로 했는지', row.account === '1' && /김일/.test(row.name));
        const detail = JSON.parse(row.detail);
        check('기록: 누가 얼마 잃고 얻었는지', detail.includes('1(김일) -20π') && detail.includes('30(박삼십) +20π'));
        check('기록: 새로 생긴 은행 기록도 적음', detail.some(d => /송금/.test(d)));

        const n = A.audit.length;
        r = await callA('PUT', '', { baseRev: 2, record: {
            users: users(80, 20), bank: { logs: [{ id: 'L1', text: '김일 → 박삼십 20π 송금' }] }, stocks: { tick: 5 }, lastSave: { build: 32 }
        } }, DEV);
        check('기록: 돈이 안 움직인 저장(주가 등)은 안 남김', r.status === 200 && A.audit.length === n);

        r = await callA('PUT', '', { baseRev: 3, record: {
            users: users(80, 20, 'secret-new'), bank: { logs: [{ id: 'L1', text: '김일 → 박삼십 20π 송금' }] }, lastSave: { build: 32 }
        } }, DEV);
        const pwRow = A.audit[A.audit.length - 1];
        check('기록: 비밀번호가 바뀌면 남김', JSON.parse(pwRow.detail).includes('1(김일) 비밀번호 바뀜'));
        check('기록: 비밀번호 값은 절대 안 적음', !A.audit.some(x => JSON.stringify(x).includes('secret-new')));

        r = await callA('POST', '?audit=login', { account: '1', ok: false }, { ...DEV, 'X-Device-Id': 'dev-bbb', 'X-Account': '' });
        check('기록: 로그인 실패를 남김', r.status === 200 && A.audit[A.audit.length - 1].kind === 'login_fail' && A.audit[A.audit.length - 1].device === 'dev-bbb');
        r = await callA('POST', '?audit=login', { account: '1', ok: true }, { ...DEV, 'X-Device-Id': 'dev-bbb' });
        check('기록: 로그인 성공을 남김', A.audit[A.audit.length - 1].kind === 'login' && /김일/.test(A.audit[A.audit.length - 1].name));

        r = await callA('POST', '?audit=list', { password: 'wrong' });
        check('기록 보기: 틀린 비밀번호는 403', r.status === 403 && !r.body.rows);
        r = await callA('POST', '?audit=list', { password: '2323' });
        check('기록 보기: 누구나 아는 기본 복구 비밀번호는 안 받음', r.status === 403);
        r = await callA('GET', '?audit=list');
        check('기록 보기: GET 으로는 안 됨', r.status === 405);
        r = await callA('POST', '?audit=list', { password: 'adminpw' });
        check('기록 보기: 관리자 비밀번호면 볼 수 있음', r.status === 200 && r.body.rows.length === A.audit.length);
        check('기록 보기: 최신 것이 먼저', r.body.rows[0].kind === 'login' && Array.isArray(r.body.rows[0].detail));
        r = await callA('POST', '?audit=list', { password: 'adminpw', account: '30' });
        check('기록 보기: 계정으로 골라 보기', r.status === 200 && r.body.rows.length === 0);

        // 오래된 기록은 지움
        A.audit[0].at = Date.now() - 40 * 86400000;
        await callA('POST', '?audit=login', { account: '30', ok: true }, DEV);
        check('기록: 30일 넘은 줄은 지워짐', !A.audit.some(x => x.at < Date.now() - 31 * 86400000));

        // 사이트를 닫아도 관리자는 기록을 볼 수 있음
        const closedA = (await import('file://' + tmpClosed)).onRequest;
        const res = await closedA({ request: req('POST', '?audit=list', { password: 'adminpw' }), env: AENV });
        check('기록 보기: 사이트를 닫아도 볼 수 있음', res.status === 200);
    }


    /* ── 선생님만: 서버가 요청마다 관리자 아이디·비밀번호를 직접 확인 ── */
    {
        const G = makeD1();
        const GENV = { get DB() { return G.db; }, RECOVERY_PASSWORD: undefined };
        G.setRaw(3, { rev: 3, users: {
            admin: { name: '관리자', role: 'admin', password: '선생님비번' },
            m1: { name: '반장', role: 'manager', password: 'mpw' },
            '1': { name: '김일', role: 'student', pi: 50, password: '1' }
        }, bank: { logs: [] } });
        const adminFn = (await import('file://' + tmpAdmin)).onRequest;
        const as = (id, pw) => (id === undefined ? {} : { 'X-Login-Id': encodeURIComponent(id), 'X-Login-Key': encodeURIComponent(pw), 'X-Device-Id': 'dev-z' });
        const callG = async (method, query, body, headers) => {
            const res = await adminFn({ request: req(method, query, body, headers), env: GENV });
            return { status: res.status, body: await res.json() };
        };
        r = await callG('GET', '');
        check('선생님만: 아이디 없이 읽으면 503', r.status === 503 && r.body.adminOnly === true && !r.body.record);
        check('선생님만: 비밀번호가 응답에 없음', !JSON.stringify(r.body).includes('선생님비번'));
        check('선생님만: 안내 문구', /학생 접속이 꺼져/.test(r.body.error));
        r = await callG('GET', '', null, as('1', '1'));
        check('선생님만: 학생은 비밀번호가 맞아도 막힘', r.status === 503 && !r.body.record);
        const blocked = G.audit[G.audit.length - 1];
        check('선생님만: 막힌 로그인을 기록 (비밀번호 맞음 표시)', blocked && blocked.kind === 'login_blocked' && blocked.account === '1' && /맞음/.test(blocked.detail) && blocked.device === 'dev-z');
        check('선생님만: 기록에 비밀번호 값 없음', !G.audit.some(x => JSON.stringify(x).includes('"1"') && JSON.stringify(x).includes('X-Login')));
        r = await callG('GET', '', null, as('m1', 'mpw'));
        check('선생님만: 매니저는 들어올 수 있음', r.status === 200 && !!r.body.record);
        r = await callG('GET', '', null, as('m1', '틀림'));
        check('선생님만: 매니저도 비밀번호 틀리면 막힘', r.status === 503);
        r = await callG('GET', '', null, as('admin', '틀림'));
        check('선생님만: 관리자라도 비밀번호 틀리면 막힘', r.status === 503 && /틀림/.test(G.audit[G.audit.length - 1].detail));
        r = await callG('GET', '', null, as('admin', '선생님비번'));
        check('선생님만: 관리자는 읽을 수 있음 (한글 비밀번호도)', r.status === 200 && r.body.record.users['1'].pi === 50);
        r = await callG('PUT', '', { baseRev: 3, record: { users: { ...r.body.record.users, '1': { ...r.body.record.users['1'], pi: 0 } }, bank: { logs: [] }, lastSave: { build: 32 } } }, as('1', '1'));
        check('선생님만: 학생 저장은 막힘', r.status === 503 && G.record().users['1'].pi === 50);
        r = await callG('PUT', '', { baseRev: 3, record: { users: { admin: { name: '관리자', role: 'admin', password: '선생님비번' }, '1': { name: '김일', role: 'student', pi: 70, password: '1' } }, bank: { logs: [] }, lastSave: { build: 32 } } }, as('admin', '선생님비번'));
        check('선생님만: 관리자 저장은 됨', r.status === 200 && G.record().users['1'].pi === 70);
        r = await callG('POST', '', { record: { users: { admin: { role: 'admin', password: 'x' } } }, password: '2323' });
        check('선생님만: 아이디 없는 되돌리기는 막힘', r.status === 503);
        r = await callG('GET', '?check=1');
        check('선생님만: 점검 주소는 열림', r.status === 200 && r.body.ok === true);
        r = await callG('POST', '?audit=list', { password: '선생님비번' });
        check('선생님만: 활동 기록 보기는 됨', r.status === 200 && r.body.rows.some(x => x.kind === 'login_blocked'));
    }


    /* ── 학생 접속 스위치: 관리자 화면에서 켜고 끄기 ── */
    {
        const S = makeD1();
        const SENV = { get DB() { return S.db; }, RECOVERY_PASSWORD: undefined };
        S.setRaw(2, { rev: 2, users: {
            admin: { name: '관리자', role: 'admin', password: 'tpw' },
            m1: { name: '반장', role: 'manager', password: 'mpw' },
            '1': { name: '김일', role: 'student', pi: 5, password: '1' }
        } });
        const fn = (await import('file://' + tmpAdmin)).onRequest;
        const as = (id, pw) => ({ 'X-Login-Id': encodeURIComponent(id), 'X-Login-Key': encodeURIComponent(pw) });
        const callS = async (method, query, body, headers) => {
            const res = await fn({ request: req(method, query, body, headers), env: SENV });
            return { status: res.status, body: await res.json() };
        };
        r = await callS('GET', '?access=1');
        check('스위치: 처음엔 기본값(선생님만)', r.status === 200 && r.body.access === 'admin');
        r = await callS('GET', '', null, as('1', '1'));
        check('스위치: 꺼져 있으면 학생 막힘', r.status === 503);
        r = await callS('POST', '?access=1', { mode: 'open' }, as('1', '1'));
        check('스위치: 학생은 못 켬', r.status === 403 && S.settings.get('access') === undefined);
        r = await callS('GET', '', null, as('m1', 'mpw'));
        check('스위치: 꺼져도 매니저는 들어옴', r.status === 200);
        r = await callS('POST', '?access=1', { mode: 'open' }, as('m1', 'mpw'));
        check('스위치: 매니저는 못 켬 (관리자만)', r.status === 403 && S.settings.get('access') === undefined);
        r = await callS('POST', '?access=1', { mode: 'open' }, as('admin', 'x'));
        check('스위치: 비밀번호 틀린 관리자도 못 켬', r.status === 403);
        check('스위치: 거부된 시도는 기록', S.audit.some(x => x.kind === 'access' && /거부/.test(x.detail)));
        r = await callS('POST', '?access=1', { mode: 'closed' }, as('admin', 'tpw'));
        check('스위치: 화면에서 \'모두 닫기\' 는 못 고름 (관리자도 못 들어오게 되므로)', r.status === 400);
        r = await callS('POST', '?access=1', { mode: 'open' }, as('admin', 'tpw'));
        check('스위치: 관리자는 켤 수 있음', r.status === 200 && r.body.access === 'open');
        check('스위치: 켠 것을 기록', S.audit.some(x => x.kind === 'access' && /켬/.test(x.detail)));
        r = await callS('GET', '?access=1');
        check('스위치: 켠 상태가 남음', r.body.access === 'open');
        r = await callS('GET', '', null, {});
        check('스위치: 켜면 학생도 읽을 수 있음', r.status === 200 && r.body.record.users['1'].pi === 5);
        r = await callS('PUT', '', { baseRev: 2, record: { users: { ...r.body.record.users, '1': { ...r.body.record.users['1'], pi: 6 } }, lastSave: { build: 32 } } }, {});
        check('스위치: 켜면 학생도 저장할 수 있음', r.status === 200 && S.record().users['1'].pi === 6);
        check('스위치: 저장 데이터에 스위치 값이 섞이지 않음 (학생이 저장으로 못 바꿈)', !('siteAccess' in S.record()) && S.settings.get('access') === 'open');
        r = await callS('POST', '?access=1', { mode: 'admin' }, as('admin', 'tpw'));
        check('스위치: 다시 끌 수 있음', r.status === 200);
        r = await callS('GET', '', null, {});
        check('스위치: 끄면 바로 막힘', r.status === 503);
        r = await callS('GET', '', null, as('admin', 'tpw'));
        check('스위치: 꺼져도 관리자는 들어옴', r.status === 200);
        // 설정을 못 읽으면 열리는 쪽이 아니라 기본값(닫힘)으로
        S.settings.set('access', '이상한값');
        r = await callS('GET', '', null, {});
        check('스위치: 이상한 값이면 기본값(선생님만)', r.status === 503);
    }


    /* ── 계정 정지: 학생 접속이 켜져 있어도 그 계정은 못 씀 ── */
    {
        const B = makeD1();
        const BENV = { get DB() { return B.db; }, RECOVERY_PASSWORD: undefined };
        B.setRaw(2, { rev: 2, users: {
            admin: { name: '관리자', role: 'admin', password: 'tpw' },
            m1: { name: '매니저', role: 'manager', password: 'mpw' },
            '7': { name: '한진우', role: 'student', pi: 5, password: '7' },
            '3': { name: '피해자', role: 'student', pi: 9, password: '3' }
        } });
        B.settings.set('access', 'open');
        const fn = (await import('file://' + tmpAdmin)).onRequest;
        const as = (id, pw) => ({ 'X-Login-Id': encodeURIComponent(id), 'X-Login-Key': encodeURIComponent(pw), 'X-Device-Id': 'dev-j' });
        const callB = async (method, query, body, headers) => {
            const res = await fn({ request: req(method, query, body, headers), env: BENV });
            return { status: res.status, body: await res.json() };
        };
        r = await callB('POST', '?ban=1', { account: '7', banned: true }, as('7', '7'));
        check('정지: 학생은 정지 못 함', r.status === 403 && !B.settings.has('banned'));
        r = await callB('POST', '?ban=1', { account: '7', banned: true }, as('m1', 'mpw'));
        check('정지: 매니저도 정지 못 함', r.status === 403);
        r = await callB('GET', '?ban=1', null, as('7', '7'));
        check('정지: 학생은 목록도 못 봄', r.status === 403);
        r = await callB('POST', '?ban=1', { account: 'admin', banned: true }, as('admin', 'tpw'));
        check('정지: 관리자 계정은 정지 못 함 (잠기면 아무도 못 품)', r.status === 400);
        r = await callB('POST', '?ban=1', { account: '없는계정', banned: true }, as('admin', 'tpw'));
        check('정지: 없는 계정은 거부', r.status === 400);
        r = await callB('GET', '', null, as('7', '7'));
        check('정지 전: 켜져 있으면 들어옴', r.status === 200);
        r = await callB('POST', '?ban=1', { account: '7', banned: true, reason: '계정 도용' }, as('admin', 'tpw'));
        check('정지: 관리자는 정지할 수 있음', r.status === 200 && r.body.banned.some(b => b.id === '7' && b.reason === '계정 도용'));
        check('정지: 기록에 남음', B.audit.some(x => x.kind === 'ban' && /한진우/.test(x.detail) && /정지/.test(x.detail)));
        r = await callB('GET', '', null, as('7', '7'));
        check('정지: 학생 접속이 켜져 있어도 정지 계정은 못 읽음', r.status === 503 && r.body.banned === true && !r.body.record);
        check('정지: 정지 안내 문구', /정지/.test(r.body.error));
        check('정지: 접속 시도가 기록됨 (기기 포함)', B.audit.some(x => x.kind === 'login_blocked' && x.account === '7' && x.device === 'dev-j'));
        r = await callB('PUT', '', { baseRev: 2, record: { users: { admin: { role: 'admin', password: 'tpw' }, '7': { pi: 999 } }, lastSave: { build: 32 } } }, { 'X-Account': '7' });
        check('정지: 로그인한 채로 열어 둔 화면의 저장도 막힘', r.status === 503 && B.record().users['7'].pi === 5);
        r = await callB('GET', '', null, as('3', '3'));
        check('정지: 다른 학생은 그대로 씀', r.status === 200);
        r = await callB('GET', '?ban=1', null, as('admin', 'tpw'));
        check('정지: 관리자는 목록을 봄', r.status === 200 && r.body.banned.length === 1);
        check('정지: 목록은 학급 기록과 따로 (저장으로 못 풂)', !JSON.stringify(B.record()).includes('banned'));
        r = await callB('POST', '?ban=1', { account: '7', banned: false }, as('admin', 'tpw'));
        check('정지: 해제할 수 있음', r.status === 200 && r.body.banned.length === 0);
        r = await callB('GET', '', null, as('7', '7'));
        check('정지: 해제하면 다시 들어옴', r.status === 200);
    }

    /* ── 사이트 닫기: 점검 말고는 아무것도 읽거나 쓸 수 없어야 함 ── */
    check('문 열기 스위치가 소스에 있음', CLOSED_FLAG.test(SRC_TEXT));
    const closedFn = (await import('file://' + tmpClosed)).onRequest;
    const callClosed = async (method, query, body) => {
        const res = await closedFn({ request: req(method, query, body), env: ENV });
        return { status: res.status, body: await res.json() };
    };
    storageUp = true;
    storage = { rev: 7, users: { admin: { password: 'pw!' }, '1': { pi: 3, password: '1' } } };
    const closedBefore = JSON.stringify(storage);
    r = await callClosed('GET', '');
    check('닫힘: 읽기 503', r.status === 503 && r.body.closed === true && !r.body.record);
    check('닫힘: 비밀번호가 응답에 없음', !JSON.stringify(r.body).includes('password'));
    r = await callClosed('GET', '?backups=1');
    check('닫힘: 백업 목록 503', r.status === 503);
    r = await callClosed('GET', '?backup=2026-01-01');
    check('닫힘: 백업 내용 503', r.status === 503 && !r.body.record);
    r = await callClosed('PUT', '', { baseRev: 7, record: { users: { admin: { password: 'x' }, '1': { pi: 999 } }, lastSave: { build: 999 } } });
    check('닫힘: 저장 503', r.status === 503);
    r = await callClosed('POST', '', { record: { users: { admin: { password: 'x' } } }, password: '2323' });
    check('닫힘: 되돌리기 503', r.status === 503);
    check('닫힘: 저장소 내용 그대로', JSON.stringify(storage) === closedBefore);
    r = await callClosed('GET', '?check=1');
    check('닫힘: 점검 주소는 열려 있음', r.status === 200 && r.body.ok === true);
    check('닫힘: 학생에게 보일 안내 문구', /닫았어요/.test(SITE_CLOSED_TEXT(SRC_TEXT)));

    console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
    const failed = results.filter(x => !x[1]).length;
    console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
