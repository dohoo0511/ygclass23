// 친구들과 하는 파티 게임 서버 (Cloudflare Worker + Durable Objects)
//
//   /api/new                → 새 방 코드 하나 받기
//   /api/rooms/CODE/ws      → 그 방에 WebSocket 으로 접속
//   그 밖의 주소             → public 폴더의 화면 파일
import { RoomCore } from "./room-core.js";
import { catalog } from "./games/index.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 I, O, 0, 1 은 뺐다
const CODE_RE = /^[A-Z0-9]{4}$/;

function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/new") {
      // 이미 사람이 있는 방 코드는 피한다
      for (let i = 0; i < 6; i++) {
        const code = newCode();
        const info = await roomStub(env, code).fetch(`https://room/info?code=${code}`).then((r) => r.json());
        if (!info.players) return json({ code });
      }
      return json({ error: "방을 만들지 못했어요. 다시 해 주세요." }, 503);
    }

    if (url.pathname === "/api/games") return json(catalog());

    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/(ws|info)$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "방 코드가 이상해요" }, 400);
      if (m[2] === "info") return roomStub(env, code).fetch(`https://room/info?code=${code}`);
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "WebSocket 으로 접속해 주세요" }, 426);
      const inner = new URL(`https://room/ws?code=${code}`);
      return roomStub(env, code).fetch(new Request(inner, request));
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "없는 주소예요" }, 404);
    return env.ASSETS.fetch(request);
  },
};

// 방 하나 = Durable Object 하나. 같은 코드로 들어온 사람은 모두 같은 객체로 모인다.
export class Room {
  constructor(state, env) {
    this.state = state;
    this.core = new RoomCore();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (code) this.core.code = code;

    if (url.pathname === "/info") return json({ code: this.core.code, players: this.core.playerCount, phase: this.core.phase });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const conn = {
      send(s) {
        try {
          server.send(s);
        } catch {}
      },
      close(c, r) {
        try {
          server.close(c, r);
        } catch {}
      },
    };
    server.addEventListener("message", (e) => this.core.message(conn, typeof e.data === "string" ? e.data : ""));
    server.addEventListener("close", () => this.core.disconnect(conn));
    server.addEventListener("error", () => this.core.disconnect(conn));
    return new Response(null, { status: 101, webSocket: client });
  }
}
