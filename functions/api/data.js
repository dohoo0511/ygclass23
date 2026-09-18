// 학급 사이트의 데이터 읽기·쓰기를 서버에서 중계하는 Cloudflare Pages 함수
// 주소: /api/data   (functions 폴더 안의 파일 위치가 곧 주소)
//
// 저장소는 Cloudflare D1(데이터베이스)입니다.
//   Cloudflare → Workers & Pages → 프로젝트 → 설정 → 바인딩 → D1 데이터베이스
//   바인딩 이름을 DB 로 등록하세요. 표(테이블)는 이 파일이 알아서 만듭니다.
//
// 예전에 쓰던 jsonbin 도 그대로 둡니다 (환경 변수 JSONBIN_BIN_ID / JSONBIN_KEY).
//   - D1 이 비어 있으면, 처음 한 번 jsonbin 의 내용을 D1 으로 옮겨 옵니다 (자료가 사라지지 않게).
//   - D1 바인딩이 아직 없으면 예전처럼 jsonbin 으로 동작합니다 (배포 순서 때문에 사이트가 멈추지 않게).
//
// 이 함수가 있는 한, 저장은 반드시 "내가 읽은 판번호(baseRev)가 아직 최신일 때만" 이루어진다.
// 오래된 화면이 통째로 덮어쓰는 일이 구조적으로 불가능해진다.
// D1 에서는 그 확인과 저장이 한 문장(UPDATE ... WHERE rev = ?)으로 끝나므로,
// "읽고 나서 쓰기 직전" 의 아주 짧은 빈틈조차 없어진다.

const JSONBIN = "https://api.jsonbin.io/v3/b";

// 저장을 허용할 최소 화면 버전.
// 기기마다 다른 버전이 돌면, 예전 버전이 주가 기록을 자기 방식으로 되돌려 놓고
// 새 버전이 다시 고치는 일이 끝없이 반복됩니다 (그래프가 계속 1시간치에서 멈추던 원인).
// 예전 버전의 저장을 아예 막아서, 모든 기기가 같은 버전으로 모이게 합니다.
// 화면을 크게 바꿀 때만 올리세요. 올리면 예전 화면은 저장할 수 없고 스스로 새로고침합니다.
const MIN_CLIENT_BUILD = 14;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function revOf(record) {
  return record && typeof record.rev === "number" ? record.rev : 0;
}

// 학급 기록을 통째로 날리는 저장을 서버에서 막는 마지막 방어선
function looksValid(record) {
  return !!record
    && typeof record === "object"
    && !Array.isArray(record)
    && !!record.users
    && typeof record.users === "object"
    && Object.keys(record.users).length > 0;
}

function hasD1(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

function hasJsonbin(env) {
  return !!(env && env.JSONBIN_BIN_ID && env.JSONBIN_KEY);
}

function backendName(env) {
  return hasD1(env) ? "D1" : "jsonbin";
}

/* ===================== D1 (기본 저장소) =====================
   표는 두 개뿐입니다.
     state   : 지금의 학급 기록 한 줄 (id = 1)
     backups : 하루 한 번 남기는 사본
   판번호(rev)를 따로 칸으로 두는 이유는, 저장을 "판번호가 그대로일 때만" 으로
   데이터베이스가 직접 보장하게 하기 위해서입니다. */

const CREATE_STATE = `CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY,
  rev INTEGER NOT NULL,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const CREATE_BACKUPS = `CREATE TABLE IF NOT EXISTS backups (
  date TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  rev INTEGER,
  users INTEGER,
  at TEXT
)`;

// 같은 서버 인스턴스에서 표 만들기를 매번 되풀이하지 않도록 기억해 둡니다
const schemaReady = new WeakSet();

async function ensureSchema(env) {
  const db = env.DB;
  if (schemaReady.has(db)) return;
  await db.prepare(CREATE_STATE).run();
  await db.prepare(CREATE_BACKUPS).run();
  schemaReady.add(db);
}

function parseRecord(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("저장소 데이터 형식이 올바르지 않아요");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("저장소 데이터 형식이 올바르지 않아요");
  }
  return parsed;
}

// 지금 들어 있는 줄. 아직 아무것도 없으면 null
async function d1Row(env) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT rev, record FROM state WHERE id = 1").first();
  if (!row) return null;
  return { rev: typeof row.rev === "number" ? row.rev : Number(row.rev) || 0, record: parseRecord(row.record) };
}

// 데이터베이스가 '몇 줄이 바뀌었는지' 알려준 값. 알려주지 않으면 -1 (모름)
// 모를 때는 '저장됐다' 고 믿지 않고 반드시 다시 읽어서 확인합니다.
// 저장되지 않았는데 저장됐다고 답하는 것이, 이 사이트에서 제일 위험한 실수이기 때문입니다.
function changesOf(result) {
  const meta = result && result.meta;
  return meta && typeof meta.changes === "number" ? meta.changes : -1;
}

// 판번호가 baseRev 그대로일 때만 저장. 저장했으면 true, 그 사이 누가 먼저 저장했으면 false.
// 줄이 아직 없을 때(첫 저장)도 같은 문장 하나로 처리됩니다.
async function d1WriteIfRev(env, record, baseRev) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    `INSERT INTO state (id, rev, record, updated_at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET rev = ?1, record = ?2, updated_at = ?3
     WHERE state.rev = ?4`
  ).bind(revOf(record), JSON.stringify(record), new Date().toISOString(), baseRev).run();

  if (changesOf(result) > 0) return true;
  // 안 들어갔거나, 들어갔는지 알 수 없는 경우 → 실제로 들어갔는지 눈으로 확인합니다
  const row = await d1Row(env);
  return !!row && row.rev === revOf(record);
}

// 판번호를 따지지 않고 그대로 씀 (되돌리기·옮겨오기 전용)
async function d1Write(env, record) {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO state (id, rev, record, updated_at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET rev = ?1, record = ?2, updated_at = ?3`
  ).bind(revOf(record), JSON.stringify(record), new Date().toISOString()).run();
}

/* ===================== jsonbin (예전 저장소) ===================== */

async function binFetch(env, path, init = {}) {
  return fetch(`${JSONBIN}/${env.JSONBIN_BIN_ID}${path}`, {
    ...init,
    headers: { "X-Master-Key": env.JSONBIN_KEY, ...(init.headers || {}) },
  });
}

async function binReadLatest(env) {
  const res = await binFetch(env, "/latest");
  if (!res.ok) throw new Error(`저장소를 읽지 못했어요 (${res.status})`);
  const data = await res.json();
  const record = data && data.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("저장소 데이터 형식이 올바르지 않아요");
  return record;
}

async function binWrite(env, record) {
  const res = await binFetch(env, "", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new Error(`저장소에 쓰지 못했어요 (${res.status})`);
}

/* ===================== 저장소 공통 창구 ===================== */

// D1 이 비어 있으면 예전 저장소(jsonbin)의 내용을 처음 한 번 옮겨 옵니다.
// 옮긴 뒤로는 D1 만 씁니다 (양쪽에 쓰면 어느 쪽이 진짜인지 알 수 없게 되므로).
let lastSeed = null;

async function seedFromJsonbin(env) {
  if (!hasJsonbin(env)) return null;
  let old;
  try {
    old = await binReadLatest(env);
  } catch (error) {
    console.error("예전 저장소를 읽지 못해 옮겨오기를 건너뜁니다:", error.message);
    return null;
  }
  if (!looksValid(old)) return null;
  await d1Write(env, old);
  lastSeed = { at: new Date().toISOString(), rev: revOf(old), users: Object.keys(old.users).length };
  return old;
}

// 지금 들어 있는 학급 기록. 저장소가 완전히 비어 있으면 {} (화면이 처음 자료를 만들 수 있게)
async function readLatest(env) {
  if (!hasD1(env)) return binReadLatest(env);
  const row = await d1Row(env);
  if (row) return row.record;
  const moved = await seedFromJsonbin(env);
  if (moved) return moved;
  return {};
}

// 판번호를 따지지 않는 저장 (되돌리기 전용)
async function writeRecord(env, record) {
  if (hasD1(env)) return d1Write(env, record);
  return binWrite(env, record);
}

// 판번호가 baseRev 그대로일 때만 저장. 먼저 저장된 게 있으면 false
async function writeRecordIfRev(env, record, baseRev) {
  if (hasD1(env)) return d1WriteIfRev(env, record, baseRev);
  // jsonbin 에는 '조건부 저장' 이 없습니다. 부르는 쪽에서 방금 읽어 판번호를 맞춰 보고 옵니다
  await binWrite(env, record);
  return true;
}

// 저장소에 예전 버전이 남아 있는지 확인 (되살릴 수 있는지 판단용)
function pickVersions(data) {
  const candidates = [data && data.record && data.record.versions, data && data.versions, data && data.record];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}

const NO_VERSION_HINT =
  "예전 버전을 쓸 수 없어요. jsonbin 요금제에서 버전 보관을 지원하지 않거나 꺼져 있을 수 있어요. " +
  "이때는 restore.html 대신, 사이트 화면 위 빨간 띠의 '이 기기에 남은 … 상태로 되살리기' 를 쓰세요.";

const D1_VERSION_HINT =
  "Cloudflare D1 에는 '저장소 예전 버전' 이 없습니다. 대신 자동 백업(날짜별 사본)을 쓰세요. " +
  "restore.html 맨 위의 '자동 백업에서 되돌리기' 에서 날짜를 고르면 됩니다.";

async function versionSummary(env) {
  if (!hasJsonbin(env)) {
    return { available: false, reason: "D1 저장소에는 버전 보관이 없어요", hint: D1_VERSION_HINT };
  }
  let res;
  try {
    res = await binFetch(env, "/versions");
  } catch (error) {
    return { available: false, reason: error.message, hint: NO_VERSION_HINT };
  }
  if (!res.ok) return { available: false, reason: `HTTP ${res.status}`, hint: NO_VERSION_HINT };

  const list = pickVersions(await res.json().catch(() => null));
  if (!Array.isArray(list) || list.length === 0) {
    return { available: false, reason: "보관된 예전 버전이 없어요", hint: NO_VERSION_HINT };
  }
  const times = list.map((v) => v && (v.createdAt || v.created_at)).filter(Boolean).sort();
  return {
    available: true,
    count: list.length,
    oldest: times[0] || null,
    newest: times[times.length - 1] || null,
    hint: `예전 버전 ${list.length}개가 남아 있어요. restore.html 에서 되살릴 시점을 고르면 됩니다.`,
  };
}

// 그래프가 이상할 때 원인을 찾기 위한 요약. 학생 정보는 담지 않는다
function stockDiagnosis(record) {
  const st = record && record.stocks;
  if (!st || !st.companies) return { available: false, reason: "주식 데이터가 없어요" };
  const HOUR = 60 * 60 * 1000;
  const tickMs = typeof st.tickMs === "number" ? st.tickMs : null;
  const perCompany = {};
  Object.keys(st.companies).forEach((id) => {
    const c = st.companies[id];
    const h = Array.isArray(c.history) ? c.history : [];
    perCompany[id] = {
      price: c.price,
      anchor: typeof c.anchor === "number" ? Math.round(c.anchor * 10) / 10 : null,
      trend: typeof c.trend === "number" ? Math.round(c.trend * 100) / 100 : null,
      historyLength: h.length,
      min: h.length ? Math.min(...h) : null,
      max: h.length ? Math.max(...h) : null,
      last26: h.slice(-26),
    };
  });
  const len = perCompany[Object.keys(perCompany)[0]].historyLength;
  const now = Date.now();
  const lastTick = typeof st.lastTick === "number" ? st.lastTick : null;
  // 그래프는 (historyStartTick + i) * tickMs 로 시각을 만든다. 그게 실제 시각과 맞는지 본다
  const lastPointMs = lastTick !== null && tickMs ? (st.historyStartTick + len - 1) * tickMs : null;
  return {
    available: true,
    tickMs,
    tickLabel: tickMs ? `${tickMs / HOUR}시간` : "기록 없음(예전 30분으로 간주)",
    lastTick,
    historyStartTick: st.historyStartTick,
    // 아래 두 값이 크게 다르면 그래프 시간축이 어긋난 것
    회차번호가_가리키는_마지막시각: lastPointMs ? new Date(lastPointMs).toISOString() : null,
    지금: new Date(now).toISOString(),
    몇시간_뒤처졌나: lastPointMs ? Math.round((now - lastPointMs) / HOUR * 10) / 10 : null,
    기록이_덮는_기간_시간: tickMs ? Math.round(len * tickMs / HOUR) : null,
    회사: perCompany,
  };
}

// 데이터가 예전으로 돌아갔을 때 쓰는 복구 비밀번호.
// 관리자 비밀번호가 기억나지 않거나 학생이 알아냈을 때를 대비한 예비 열쇠입니다.
// 이 값은 서버에만 있고 화면(index.html)에는 나가지 않습니다.
// 바꾸려면 Cloudflare 환경 변수 RECOVERY_PASSWORD 를 등록하세요 (그 값이 우선합니다).
const DEFAULT_RECOVERY_PASSWORD = "2323";

/* ===================== 자동 백업 =====================
   하루 한 번 자동으로 사본을 남깁니다.
   아무도 아무것도 누르지 않아도 최근 며칠치가 남아 있어, 날짜를 골라 되돌릴 수 있습니다.
   D1 이 있으면 D1 의 backups 표에, 없으면 예전처럼 KV(BACKUPS)에 남깁니다.
   예전에 KV 에 남겨 둔 사본도 그대로 목록에 나오고 되돌릴 수 있습니다. */
const BACKUP_KEEP_DAYS = 14;
const BACKUP_INDEX_KEY = "backup:index";
const KST_OFFSET = 9 * 60 * 60 * 1000;

function kstDate(ms = Date.now()) {
  return new Date(ms + KST_OFFSET).toISOString().slice(0, 10);
}
function backupKey(date) {
  return `backup:${date}`;
}
async function readBackupIndex(kv) {
  const raw = await kv.get(BACKUP_INDEX_KEY, { type: "json" });
  return Array.isArray(raw) ? raw : [];
}

async function kvEnsureDailyBackup(kv, record, today) {
  const index = await readBackupIndex(kv);
  if (index.some((e) => e.date === today)) return;

  await kv.put(backupKey(today), JSON.stringify(record));
  const entry = {
    date: today,
    at: new Date().toISOString(),
    rev: revOf(record),
    users: Object.keys(record.users || {}).length,
  };
  const next = [entry, ...index.filter((e) => e.date !== today)].slice(0, BACKUP_KEEP_DAYS);
  await kv.put(BACKUP_INDEX_KEY, JSON.stringify(next));

  // 보관 기간을 넘긴 사본은 지운다
  for (const old of index) {
    if (!next.some((e) => e.date === old.date)) await kv.delete(backupKey(old.date));
  }
}

async function d1EnsureDailyBackup(env, record, today) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO backups (date, record, rev, users, at) VALUES (?, ?, ?, ?, ?)"
  ).bind(today, JSON.stringify(record), revOf(record), Object.keys(record.users || {}).length, new Date().toISOString()).run();
  if (changesOf(result) === 0) return; // 오늘 사본이 이미 있음 (모를 때는 -1 이라 아래 정리를 한 번 더 해도 무해)
  // 보관 기간을 넘긴 사본은 지운다
  await env.DB.prepare(
    "DELETE FROM backups WHERE date NOT IN (SELECT date FROM backups ORDER BY date DESC LIMIT ?)"
  ).bind(BACKUP_KEEP_DAYS).run();
}

// 오늘 사본이 없으면 남긴다. 하루 한 번이라 저장 횟수가 거의 들지 않는다
async function ensureDailyBackup(env, record) {
  if (!looksValid(record)) return;
  const today = kstDate();
  if (hasD1(env)) return d1EnsureDailyBackup(env, record, today);
  const kv = env && env.BACKUPS;
  if (!kv) return;
  return kvEnsureDailyBackup(kv, record, today);
}

// 날짜별 사본 목록. D1 과 KV 양쪽을 합쳐서 보여준다 (같은 날짜는 D1 이 우선)
async function backupEntries(env) {
  const byDate = new Map();
  const kv = env && env.BACKUPS;
  if (kv) {
    for (const e of await readBackupIndex(kv)) {
      if (e && e.date) byDate.set(e.date, { ...e, where: "KV" });
    }
  }
  if (hasD1(env)) {
    await ensureSchema(env);
    const res = await env.DB.prepare("SELECT date, at, rev, users FROM backups ORDER BY date DESC").all();
    for (const r of (res && res.results) || []) {
      if (r && r.date) byDate.set(r.date, { date: r.date, at: r.at, rev: r.rev, users: r.users, where: "D1" });
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

async function backupGet(env, date) {
  if (hasD1(env)) {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT record FROM backups WHERE date = ?").bind(date).first();
    if (row && row.record) return parseRecord(row.record);
  }
  const kv = env && env.BACKUPS;
  if (kv) {
    const fromKv = await kv.get(backupKey(date), { type: "json" });
    if (fromKv) return fromKv;
  }
  return null;
}

async function backupSummary(env) {
  if (!hasD1(env) && !(env && env.BACKUPS)) {
    return {
      available: false,
      hint: "자동 백업이 꺼져 있어요. Cloudflare 에서 D1 데이터베이스를 만들고 바인딩 이름을 DB 로 등록하면 하루 한 번 자동으로 사본이 남습니다. (SETUP.md 참고)",
    };
  }
  try {
    const index = await backupEntries(env);
    return {
      available: true,
      where: hasD1(env) ? "D1" : "KV",
      count: index.length,
      keepDays: BACKUP_KEEP_DAYS,
      dates: index.map((e) => e.date),
      // 날짜마다 학생 수·판번호를 함께 보내, 되돌리기 전에 어느 시점인지 눈으로 고를 수 있게 함
      entries: index,
      newest: index[0] || null,
      hint: index.length
        ? `자동 백업 ${index.length}개가 있어요. restore.html 에서 날짜를 고르면 그 시점으로 되돌아갑니다.`
        : "자동 백업이 켜졌어요. 다음 저장 때 첫 사본이 남습니다.",
    };
  } catch (error) {
    return { available: false, reason: error.message, hint: "백업 목록을 읽지 못했어요." };
  }
}

// 관리자 비밀번호 확인 (되돌리기처럼 위험한 작업에만 사용)
function isAdminPassword(current, password) {
  const admin = current && current.users && current.users.admin;
  return !!admin && typeof password === "string" && password.length > 0 && admin.password === password;
}

// 되돌리기를 해도 되는가. 관리자 비밀번호 또는 복구 비밀번호면 통과
function canRestore(current, password, env) {
  if (typeof password !== "string" || password.length === 0) return false;
  const recovery = (env && env.RECOVERY_PASSWORD) || DEFAULT_RECOVERY_PASSWORD;
  if (password === recovery) return true;
  return isAdminPassword(current, password);
}

// 저장소 설정이 왜 안 보이는지 알려줌.
// 값은 절대 돌려주지 않고, 이름만 (그것도 저장소와 관련 있어 보이는 것만) 보여준다
const JSONBIN_VARS = ["JSONBIN_BIN_ID", "JSONBIN_KEY"];

function envDiagnosis(env) {
  const vars = env || {};
  const names = Object.keys(vars);
  const missing = JSONBIN_VARS.filter((name) => !vars[name]);
  // 이름은 있는데 값이 비어 있는 경우 (붙여넣기가 안 된 경우)
  const emptyValue = missing.filter((name) => name in vars);
  // 철자가 틀렸는지 알 수 있도록, 저장소와 관련 있어 보이는 이름만 보여줌
  const similarNames = names.filter((name) => /json|bin/i.test(name));
  const unexpected = similarNames.filter((name) => !JSONBIN_VARS.includes(name));

  const setupD1 =
    "Cloudflare → Workers & Pages → 프로젝트 → 설정 → 바인딩 에서 D1 데이터베이스를 만들고 " +
    "바인딩 이름을 DB 로 등록한 뒤 재배포해주세요. (SETUP.md 참고)";

  let hint;
  if (emptyValue.length > 0) {
    hint = `${emptyValue.join(", ")} 은(는) 이름만 있고 값이 비어 있어요. 값을 다시 붙여넣고 재배포해주세요. 또는 ${setupD1}`;
  } else if (unexpected.length > 0) {
    hint = `비슷한 이름이 있어요: ${unexpected.join(", ")}. 철자가 ${JSONBIN_VARS.join(", ")} 와 정확히 같은지 확인해주세요. 또는 ${setupD1}`;
  } else if (names.length === 0) {
    hint = `이 배포에는 저장소 설정이 하나도 없어요. ${setupD1}`;
  } else {
    hint = setupD1;
  }

  return {
    missing,
    emptyValue,
    similarNames,
    varCount: names.length,
    d1: hasD1(env),
    hint,
    error: "저장소가 설정되지 않았어요. D1 바인딩(DB) 또는 JSONBIN_BIN_ID / JSONBIN_KEY 가 필요해요.",
  };
}

function storageSummary(env) {
  const summary = {
    backend: backendName(env),
    d1: hasD1(env),
    jsonbin: hasJsonbin(env),
    hint: hasD1(env)
      ? "Cloudflare D1 에 저장하고 있어요. 판번호 확인과 저장이 한 번에 이루어져, 오래된 화면이 덮어쓸 수 없습니다."
      : "아직 예전 저장소(jsonbin)를 쓰고 있어요. D1 데이터베이스를 만들고 바인딩 이름을 DB 로 등록하면 자동으로 옮겨집니다. (SETUP.md 참고)",
  };
  if (hasD1(env) && hasJsonbin(env)) {
    summary.note = "옮겨오기가 끝났다면 JSONBIN_BIN_ID / JSONBIN_KEY 는 지워도 됩니다. 남겨 두면 예전 버전 목록만 계속 볼 수 있어요.";
  }
  if (lastSeed) summary.movedFromJsonbin = lastSeed;
  return summary;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const isCheck = url.searchParams.has("check");

  if (!hasD1(env) && !hasJsonbin(env)) {
    return json({ ok: false, step: "저장소 설정", ...envDiagnosis(env) }, 503);
  }

  // 설정이 제대로 됐는지 확인하는 용도. 학생 정보는 하나도 돌려주지 않는다
  // 사용법: 사이트주소/api/data?check=1
  if (isCheck) {
    try {
      const record = await readLatest(env);
      return json({
        ok: true,
        step: "완료",
        message: `서버 함수가 저장소(${backendName(env)})에 정상 연결되었습니다.`,
        storage: storageSummary(env),
        rev: revOf(record),
        users: Object.keys(record.users || {}).length,
        lastSave: record.lastSave || null,
        restoredFrom: record.restoredFrom !== undefined ? record.restoredFrom : null,
        restoredAt: record.restoredAt || null,
        versions: await versionSummary(env),
        backups: await backupSummary(env),
        ...(url.searchParams.has("stocks") ? { stocks: stockDiagnosis(record) } : {}),
      });
    } catch (error) {
      return json({
        ok: false,
        step: "저장소 연결",
        storage: storageSummary(env),
        error: hasD1(env)
          ? `${error.message} — D1 바인딩 이름이 DB 가 맞는지 확인해주세요.`
          : `${error.message} — 새 Master Key 와 Bin ID 가 맞는지 확인해주세요.`,
      }, 502);
    }
  }

  /* ---------- 읽기 ---------- */
  if (request.method === "GET") {
    try {
      // 복구 도구용: 자동 백업 목록
      if (url.searchParams.has("backups")) {
        return json(await backupSummary(env));
      }
      // 복구 도구용: 특정 날짜 백업의 내용 (되돌리기 전에 확인하거나 파일로 보관할 때)
      const wantBackup = url.searchParams.get("backup");
      if (wantBackup !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(wantBackup)) return json({ error: "날짜 형식이 올바르지 않아요." }, 400);
        if (!hasD1(env) && !(env && env.BACKUPS)) return json({ error: "자동 백업이 꺼져 있어요." }, 400);
        const saved = await backupGet(env, wantBackup);
        if (!saved) return json({ error: `${wantBackup} 백업이 없어요.` }, 404);
        return json({ record: saved, rev: revOf(saved), date: wantBackup });
      }
      // 복구 도구용: 예전 버전 목록 (예전 저장소가 남아 있을 때만)
      if (url.searchParams.has("versions")) {
        if (!hasJsonbin(env)) return json({ error: D1_VERSION_HINT }, 400);
        const res = await binFetch(env, "/versions");
        if (!res.ok) throw new Error(`버전 목록을 읽지 못했어요 (${res.status})`);
        return json(await res.json());
      }
      // 복구 도구용: 특정 버전의 내용
      const version = url.searchParams.get("version");
      if (version !== null) {
        if (!hasJsonbin(env)) return json({ error: D1_VERSION_HINT }, 400);
        if (!/^\d{1,9}$/.test(version)) return json({ error: "버전 번호가 올바르지 않아요." }, 400);
        const res = await binFetch(env, `/${version}`);
        if (!res.ok) throw new Error(`해당 버전을 읽지 못했어요 (${res.status})`);
        return json(await res.json());
      }
      const record = await readLatest(env);
      return json({ record, rev: revOf(record) });
    } catch (error) {
      return json({ error: error.message }, 502);
    }
  }

  /* ---------- 저장 (판번호가 맞을 때만) ---------- */
  if (request.method === "PUT") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "요청 형식이 올바르지 않아요." }, 400);
    }
    const baseRev = payload && payload.baseRev;
    const record = payload && payload.record;
    if (!Number.isInteger(baseRev) || baseRev < 0) return json({ error: "baseRev 가 필요해요." }, 400);
    if (!looksValid(record)) return json({ error: "학생 정보가 없는 데이터는 저장할 수 없어요." }, 400);

    // 예전 화면이 보낸 저장은 받지 않는다 (426: 화면을 새로 고쳐야 함)
    const build = record.lastSave && record.lastSave.build;
    if (!Number.isInteger(build) || build < MIN_CLIENT_BUILD) {
      return json({
        error: "outdated",
        message: "사이트가 새로 바뀌었어요. 화면을 새로고침해 주세요.",
        needBuild: MIN_CLIENT_BUILD,
        gotBuild: Number.isInteger(build) ? build : null,
      }, 426);
    }

    let current;
    try {
      current = await readLatest(env);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    const currentRev = revOf(current);
    if (currentRev !== baseRev) {
      // 내가 읽은 뒤에 누군가 저장함 → 덮어쓰지 않고, 최신 내용을 돌려줌
      return json({ error: "conflict", rev: currentRev, record: current }, 409);
    }
    const saved = { ...record, rev: currentRev + 1 };
    let stored;
    try {
      stored = await writeRecordIfRev(env, saved, baseRev);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    if (!stored) {
      // 읽은 바로 그 순간과 쓰기 사이에 누가 먼저 저장함 (D1 이 막아 줌)
      let fresh;
      try {
        fresh = await readLatest(env);
      } catch (error) {
        return json({ error: error.message }, 502);
      }
      return json({ error: "conflict", rev: revOf(fresh), record: fresh }, 409);
    }
    // 백업이 실패해도 저장 자체는 성공으로 본다 (백업 때문에 수업이 막히면 안 됨)
    try {
      await ensureDailyBackup(env, saved);
    } catch (error) {
      console.error("자동 백업 실패:", error);
    }
    return json({ ok: true, rev: currentRev + 1 });
  }

  /* ---------- 되돌리기 (관리자 비밀번호 필요) ---------- */
  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "요청 형식이 올바르지 않아요." }, 400);
    }
    const version = payload && payload.restoreVersion;
    const uploaded = payload && payload.record;
    const backupDate = payload && payload.restoreBackup;
    const fromFile = uploaded !== undefined;
    const fromBackup = typeof backupDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(backupDate);
    if (!fromFile && !fromBackup && (!Number.isInteger(version) || version < 0)) {
      return json({ error: "되돌릴 날짜나 버전 번호, 백업 내용 중 하나가 필요해요." }, 400);
    }

    let current;
    try {
      current = await readLatest(env);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    if (!canRestore(current, payload.password, env)) {
      return json({ error: "비밀번호가 맞지 않아요. 관리자 비밀번호나 복구 비밀번호를 입력해주세요." }, 403);
    }

    let target;
    let source;
    if (fromFile) {
      target = uploaded;
      source = "백업 파일";
    } else if (fromBackup) {
      if (!hasD1(env) && !(env && env.BACKUPS)) return json({ error: "자동 백업이 꺼져 있어요." }, 400);
      try {
        target = await backupGet(env, backupDate);
      } catch (error) {
        return json({ error: `백업을 읽지 못했어요: ${error.message}` }, 502);
      }
      if (!target) return json({ error: `${backupDate} 백업이 없어요.` }, 404);
      source = `자동 백업 ${backupDate}`;
    } else {
      if (!hasJsonbin(env)) return json({ error: D1_VERSION_HINT }, 400);
      try {
        const res = await binFetch(env, `/${version}`);
        if (!res.ok) throw new Error(`해당 버전을 읽지 못했어요 (${res.status})`);
        target = (await res.json()).record;
      } catch (error) {
        return json({ error: error.message }, 502);
      }
      source = version;
    }
    if (!looksValid(target)) {
      return json({ error: "되돌릴 내용에 학생 정보가 없어요. 올바른 백업인지 확인해주세요." }, 400);
    }

    // 되돌린 뒤에도 판번호는 계속 커지도록 (되돌림 감지가 오작동하지 않게 함)
    const nextRev = Math.max(revOf(current), revOf(target)) + 1;
    try {
      await writeRecord(env, { ...target, rev: nextRev, restoredFrom: source, restoredAt: new Date().toISOString() });
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    return json({ ok: true, rev: nextRev, restoredFrom: source });
  }

  return json({ error: "GET, PUT, POST 만 받을 수 있어요." }, 405);
}
