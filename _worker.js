// ピッ！とモンスター サーバー（Cloudflare Pages の _worker.js）
// /api/jan?code=JANコード → 商品のジャンル（例：["食品","菓子","スナック菓子"]）を返す。
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
      const row = await env.DB.prepare("SELECT data FROM jan WHERE code = ?").bind(code).first();
      if (row) return json(JSON.parse(row.data));
    } catch (e) { /* 覚えられなくても、調べるのは続ける */ }
  }

  // 2. Yahoo! に聞く
  if (!env.YAHOO_APPID) return json({ error: "noappid" }, 503);
  const wait = lastCall + 1050 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 1100)));
  lastCall = Date.now();

  let res;
  try {
    const q = new URLSearchParams({ appid: env.YAHOO_APPID, jan_code: code, results: "10" });
    res = await fetch(`${YAHOO}?${q}`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    return json({ error: "network" }, 502);
  }
  if (res.status === 429) return json({ error: "busy" }, 503);
  if (!res.ok) return json({ error: "yahoo" }, 502);

  const data = await res.json();
  const result = pickGenre(data.hits || []);

  // 3. 覚えておく（見つからなかった商品も覚える）
  if (env.DB) {
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO jan (code, data, at) VALUES (?, ?, ?)")
        .bind(code, JSON.stringify(result), Date.now()).run();
    } catch (e) {}
  }
  return json(result);
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
