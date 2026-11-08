// ピッ！とモンスター サーバー（Cloudflare Pages の _worker.js）
// /api/jan?code=JANコード → 商品のジャンル（例：["食品","菓子","スナック菓子"]）を返す。
// /api/save（POST）→ 図鑑を預かって引き継ぎコードを返す。/api/load?code=… → 預かった図鑑を返す。
//   30日間、保存も読み出しもされなかったコードは自動で消す。
// それ以外のURLは、いつもどおり index.html などのファイルを返す。
//
// 設定（Pages のプロジェクト → Settings）
//   Variables and Secrets：YAHOO_APPID（種類は Secret）＝ Yahoo! のアプリケーションID（Client ID）
//   Bindings（なくても動く。あると調べた結果を覚えて、Yahoo! に聞く回数が減る）：D1 database、名前は DB

const YAHOO = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";
let lastCall = 0; // Yahoo! は 1秒に1回まで

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/jan") return jan(url, env);
    if (url.pathname === "/api/save" && req.method === "POST") return saveDex(req, env);
    if (url.pathname === "/api/load") return loadDex(url, env);
    return env.ASSETS.fetch(req);
  },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function jan(url, env) {
  const code = url.searchParams.get("code") || "";
  if (!/^(\d{8}|\d{13})$/.test(code)) return json({ error: "badcode" }, 400);

  // 1. 覚えている結果があれば、それを返す
  if (env.DB) {
    try {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS jan (code TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)").run();
      const row = await env.DB.prepare("SELECT data, at FROM jan WHERE code = ?").bind(code).first();
      if (row) {
        const data = JSON.parse(row.data);
        // 見つからなかった商品は、7日たったら調べ直す（あとから出品されることがあるため）
        if (data.found || Date.now() - row.at < 7 * 864e5) return json(data);
      }
    } catch (e) { /* 覚えられなくても、調べるのは続ける */ }
  }

  // 2. Yahoo! に聞く（JANコードで探し、なければ番号そのものを検索語にしてもう一度）
  if (!env.YAHOO_APPID) return json({ error: "noappid" }, 503);
  let result;
  for (const by of ["jan_code", "query"]) {
    const r = await ask(env.YAHOO_APPID, by, code);
    if (r.error) return json({ error: r.error }, r.error === "busy" ? 503 : 502);
    result = pickGenre(r.hits);
    if (result.found) break;
  }

  // 3. 覚えておく（見つからなかった商品も覚える）
  if (env.DB) {
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO jan (code, data, at) VALUES (?, ?, ?)")
        .bind(code, JSON.stringify(result), Date.now()).run();
    } catch (e) {}
  }
  return json(result);
}

async function ask(appid, by, code) {
  const wait = lastCall + 1050 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 1100)));
  lastCall = Date.now();
  let res;
  try {
    const q = new URLSearchParams({ appid, [by]: code, results: "10" });
    res = await fetch(`${YAHOO}?${q}`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    return { error: "network" };
  }
  if (res.status === 429) return { error: "busy" };
  if (!res.ok) return { error: "yahoo" };
  const data = await res.json();
  return { hits: data.hits || [] };
}

// 出品ごとにジャンルの付け方が少しずつ違うので、いちばん多いジャンルを選ぶ。
// 返すのはジャンル名だけ（商品名やお店の情報は返さない）。
function pickGenre(hits) {
  const count = new Map();
  for (const h of hits) {
    const parents = (h.parentGenreCategories || [])
      .filter((p) => p && p.depth >= 1 && p.name)
      .sort((a, b) => a.depth - b.depth)
      .map((p) => p.name);
    const leaf = h.genreCategory && h.genreCategory.name;
    const path = [...parents, leaf].filter(Boolean).slice(0, 3);
    if (!path.length) continue;
    const key = path.join("\u0000");
    count.set(key, (count.get(key) || 0) + 1);
  }
  if (!count.size) return { found: false };
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { found: true, path: best.split("\u0000") };
}

// ---------- 引き継ぎコード ----------
const KEEP_DAYS = 30;           // この日数使われなかったら消す
const MAX_BYTES = 300 * 1024;   // 1つの図鑑の大きさの上限
const ISSUE_PER_DAY = 10;       // 1つの回線から1日に発行できる数
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 見まちがえやすい I O L 0 1 を除く

async function setupSaves(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS saves (code TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS issues (k TEXT PRIMARY KEY, n INTEGER NOT NULL, day TEXT NOT NULL)"),
  ]);
}
function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map((x) => ALPHA[x % ALPHA.length]).join("");
}
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
async function ipKey(req) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pipi:" + ip));
  return [...new Uint8Array(h)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function cleanup(db) {
  // ときどき（100回に1回ほど）古いものを掃除する
  if (Math.random() > 0.01) return;
  const old = Date.now() - KEEP_DAYS * 864e5;
  await db.batch([
    db.prepare("DELETE FROM saves WHERE at < ?").bind(old),
    db.prepare("DELETE FROM issues WHERE day < ?").bind(today()),
    db.prepare("DELETE FROM jan WHERE data = '{\"found\":false}' AND at < ?").bind(Date.now() - 30 * 864e5),
  ]).catch(() => {});
}

async function saveDex(req, env) {
  if (!env.DB) return json({ error: "nodb" }, 503);
  const text = await req.text();
  if (text.length > MAX_BYTES) return json({ error: "toolarge" }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: "bad" }, 400); }
  if (!body || typeof body.data !== "object" || body.data === null) return json({ error: "bad" }, 400);
  const data = JSON.stringify(body.data);
  const db = env.DB;
  await setupSaves(db);
  await cleanup(db);

  // すでにあるコードの上書き
  if (body.code) {
    const code = String(body.code).toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(code)) return json({ error: "bad" }, 400);
    const r = await db.prepare("UPDATE saves SET data = ?, at = ? WHERE code = ?").bind(data, Date.now(), code).run();
    if (!r.meta || !r.meta.changes) return json({ error: "notfound" }, 404);
    return json({ ok: true, code });
  }

  // 新しいコードの発行（回線ごとに1日の上限あり）
  const k = await ipKey(req), day = today();
  const row = await db.prepare("SELECT n FROM issues WHERE k = ? AND day = ?").bind(k, day).first();
  if (row && row.n >= ISSUE_PER_DAY) return json({ error: "limit" }, 429);
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      await db.batch([
        db.prepare("INSERT INTO saves (code, data, at) VALUES (?, ?, ?)").bind(code, data, Date.now()),
        db.prepare("INSERT INTO issues (k, n, day) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN day = excluded.day THEN n + 1 ELSE 1 END, day = excluded.day").bind(k, day),
      ]);
      return json({ ok: true, code });
    } catch (e) { /* まれにコードがかぶったら作り直す */ }
  }
  return json({ error: "busy" }, 503);
}

async function loadDex(url, env) {
  if (!env.DB) return json({ error: "nodb" }, 503);
  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code)) return json({ error: "bad" }, 400);
  const db = env.DB;
  await setupSaves(db);
  const row = await db.prepare("SELECT data, at FROM saves WHERE code = ?").bind(code).first();
  if (!row || row.at < Date.now() - KEEP_DAYS * 864e5) return json({ error: "notfound" }, 404);
  await db.prepare("UPDATE saves SET at = ? WHERE code = ?").bind(Date.now(), code).run();
  return json({ data: JSON.parse(row.data) });
}
