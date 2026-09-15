// 학급 주식 게임의 뉴스 여러 건을 Google Gemini(무료 등급)가 한 번에 기사로 써 주는 Cloudflare Pages 함수
// 주소: /api/stock-news (functions 폴더 안의 파일 위치가 곧 주소)
// 필요한 환경 변수: GEMINI_API_KEY (Cloudflare → Workers & Pages → 프로젝트 → 설정 → 변수 및 비밀)
// 저장소(JSONBin) 요청 횟수를 아끼기 위해 이 함수는 저장소를 읽지 않고, 화면이 보낸 사건 정보만 사용함

const MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_ITEMS = 8;

const COMPANIES = {
  taehoon: { name: "태훈전자", industry: "스마트폰·노트북 같은 전자기기" },
  ttaek: { name: "땍이네 땍배", industry: "택배" },
  dohoo: { name: "도후식품", industry: "과자·라면 같은 식품" },
  pharma23: { name: "23제약", industry: "감기약·비타민 같은 의약품" },
};

const KIND_LABELS = {
  single: "회사 한 곳의 소식",
  contract_sign: "두 회사의 새 계약 체결",
  contract_expand: "두 회사의 기존 계약 확대",
  contract_end: "두 회사의 계약 해지",
  contract_fail: "두 회사의 계약 협상 결렬",
};

const LEVEL_LABELS = { small: "작음", medium: "보통", large: "큼" };

const SYSTEM_PROMPT = `너는 학생들이 참여하는 학급 경제 게임의 가상 경제 신문 기자다. 게임 속 회사는 모두 지어낸 회사다.
- 태훈전자: 스마트폰·노트북 같은 전자기기 회사
- 땍이네 땍배: 택배 회사
- 도후식품: 과자·라면 같은 식품 회사
- 23제약: 감기약·비타민 같은 약을 만드는 제약 회사

주어진 사건마다 짧은 한국어 경제 뉴스 기사를 하나씩 쓴다.
- 사건마다 받은 id를 그대로 붙여서, 사건 수만큼 기사를 돌려준다.
- 제목은 30자 이내, 본문은 2~3문장 150자 이내로 쓴다.
- 호재/악재 방향과 영향 크기에 맞게 쓴다. 호재를 나쁜 일처럼, 악재를 좋은 일처럼 쓰지 않는다.
- 계약 관련 사건이면 두 회사 이름과 계약 내용을 모두 넣는다.
- 주가가 올랐는지 떨어졌는지는 쓰되, 가격이나 퍼센트 같은 숫자는 쓰지 않는다.
- 초등학생·중학생이 읽기 쉬운 말로 쓴다. 실제 기업·브랜드·인물, 정치, 사고, 질병 유행, 폭력 이야기는 넣지 않는다.
- 한 번에 받은 기사들끼리, 그리고 최근 기사들과 제목·첫 문장·표현이 겹치지 않게 매번 다른 방식으로 쓴다.
  (예: 인터뷰 한마디, 소비자 반응, 앞으로의 계획, 업계 분위기 등 기사마다 다른 각도를 고른다)`;

// Gemini responseSchema 형식 (타입 이름은 대문자)
// 여러 건을 한 번에 부탁하면 일부만 쓰는 경우가 있어서, 요청한 id만 쓸 수 있고 개수도 정확히 맞추도록 매번 만듦
function responseSchemaFor(ids) {
  return {
    type: "OBJECT",
    properties: {
      articles: {
        type: "ARRAY",
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", enum: ids },
            title: { type: "STRING" },
            body: { type: "STRING" },
          },
          required: ["id", "title", "body"],
        },
      },
    },
    required: ["articles"],
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function clean(text, maxLength) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// 화면이 보낸 사건 정보를 검사해서 정해진 값만 통과시킴
function validateItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { id, kind, companyId, partnerId, sentiment, level, deltas, title } = raw;
  if (typeof id !== "string" || !/^n\d{1,9}$/.test(id)) return null;
  if (!KIND_LABELS[kind] || !COMPANIES[companyId]) return null;
  if (kind !== "single" && !COMPANIES[partnerId]) return null;
  if (sentiment !== "good" && sentiment !== "bad") return null;
  if (!LEVEL_LABELS[level]) return null;
  if (typeof title !== "string" || title.length === 0 || title.length > 80) return null;
  const safeDeltas = {};
  if (deltas && typeof deltas === "object") {
    for (const [key, value] of Object.entries(deltas)) {
      if (COMPANIES[key] && Number.isInteger(value) && Math.abs(value) <= 200) safeDeltas[key] = value;
    }
  }
  return { id, kind, companyId, partnerId: kind === "single" ? null : partnerId, sentiment, level, deltas: safeDeltas, title };
}

function describeItem(item) {
  const main = COMPANIES[item.companyId];
  const lines = [
    `[id: ${item.id}]`,
    `사건 종류: ${KIND_LABELS[item.kind]}`,
    `중심 회사: ${main.name} (${main.industry})`,
  ];
  if (item.partnerId) {
    const partner = COMPANIES[item.partnerId];
    lines.push(`상대 회사: ${partner.name} (${partner.industry})`);
  }
  lines.push(`방향: ${item.sentiment === "good" ? "호재" : "악재"}`);
  lines.push(`영향 크기: ${LEVEL_LABELS[item.level]}`);
  const moved = Object.entries(item.deltas)
    .filter(([, delta]) => delta !== 0)
    .map(([id, delta]) => `${COMPANIES[id].name} ${delta > 0 ? "상승" : "하락"}`);
  if (moved.length) lines.push(`주가가 움직인 회사: ${moved.join(", ")}`);
  lines.push(`사건 요약(게임이 만든 기본 문장, 이 내용을 바탕으로 쓸 것): ${item.title}`);
  return lines.join("\n");
}

function geminiErrorMessage(status, data) {
  const detail = data && data.error && data.error.message ? ` - ${data.error.message}` : "";
  if (status === 429) return "Gemini 무료 사용량 한도를 넘었어요. 잠시 후 다시 시도돼요.";
  if (status === 400 || status === 403) return `Gemini API 키나 요청 설정을 확인해주세요 (${status})${detail}`;
  return `Gemini 요청 실패 (${status})${detail}`;
}

// Cloudflare Pages 함수: context.request로 요청을, context.env로 환경 변수를 받음
export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ error: "POST 요청만 받을 수 있어요." }, 405);
  const apiKey = env && env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "GEMINI_API_KEY 환경 변수가 설정되지 않았어요." }, 500);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요." }, 400);
  }
  const rawItems = payload && Array.isArray(payload.items) ? payload.items : [];
  if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return json({ error: `뉴스는 1~${MAX_ITEMS}건씩 요청할 수 있어요.` }, 400);
  }
  const items = rawItems.map(validateItem);
  if (items.some((item) => item === null)) return json({ error: "뉴스 정보가 올바르지 않아요." }, 400);

  const recent = (Array.isArray(payload.recent) ? payload.recent : [])
    .filter((title) => typeof title === "string" && title.length <= 80)
    .slice(0, 8);

  const first = await writeArticles(apiKey, items, recent);
  if (first.error) return json({ error: first.error }, first.status);

  // 빠진 기사가 있으면 그것만 한 번 더 부탁함 (다시 실패하면 받은 기사만 돌려주고, 나머지는 화면이 나중에 다시 요청)
  const articles = [...first.articles];
  const missing = items.filter((item) => !articles.some((a) => a.id === item.id));
  if (missing.length > 0) {
    const second = await writeArticles(apiKey, missing, [...articles.map((a) => a.title), ...recent].slice(0, 8));
    if (!second.error) articles.push(...second.articles);
  }
  if (articles.length === 0) return json({ error: "Gemini 응답에 쓸 수 있는 기사가 없어요." }, 502);

  return json({ articles });
}

// Gemini에 한 번 요청해서 { articles } 또는 { error, status }를 돌려줌
async function writeArticles(apiKey, items, recent) {
  const ids = items.map((item) => item.id);
  const prompt = [
    `다음 ${items.length}개 사건으로 기사를 하나씩, 빠짐없이 모두 ${items.length}개 써줘.`,
    "",
    items.map(describeItem).join("\n\n"),
    ...(recent.length ? ["", "최근 기사 제목 (겹치지 않게 쓸 것):", ...recent.map((title) => `- ${title}`)] : []),
  ].join("\n");

  let geminiResponse;
  try {
    geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: responseSchemaFor(ids) },
      }),
    });
  } catch (error) {
    return { error: `Gemini 서버에 연결하지 못했어요: ${error.message}`, status: 502 };
  }

  const data = await geminiResponse.json().catch(() => null);
  if (!geminiResponse.ok) {
    return { error: geminiErrorMessage(geminiResponse.status, data), status: geminiResponse.status === 429 ? 429 : 502 };
  }

  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join("");
  if (!text) {
    const reason = (data && data.promptFeedback && data.promptFeedback.blockReason) || (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason) || "응답 없음";
    return { error: `Gemini가 기사를 만들지 않았어요 (${reason})`, status: 422 };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Gemini 응답이 JSON 형식이 아니에요.", status: 502 };
  }
  const articles = [];
  (parsed && Array.isArray(parsed.articles) ? parsed.articles : []).forEach((a) => {
    // 같은 id를 두 번 쓴 경우 첫 번째만 사용
    if (!a || !ids.includes(a.id) || articles.some((x) => x.id === a.id)) return;
    if (typeof a.title !== "string" || typeof a.body !== "string" || !a.title.trim() || !a.body.trim()) return;
    articles.push({ id: a.id, title: clean(a.title, 40), body: clean(a.body, 160) });
  });
  return { articles };
}
