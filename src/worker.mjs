"use strict";
// akiba-card-map worker: serves the static frontend (Workers Static Assets),
// the public store API, 0g0-id login (authorization code + PKCE), and the
// login-protected admin API. Store data lives in D1; the browser no longer
// keeps its own copy.
//
// Standing rule (same as Hyo/Kosu): the OIDC `sub` is kept only inside the
// accounts table. Everything shown to the browser or returned by the API
// uses the internal account id instead.

import { validate, validateRows, nextId, STATIONS, REGION } from "./store-validation.mjs";
import { createDb } from "./db.mjs";
import {
  getDiscovery, exchangeCode, verifyIdToken,
  randomToken, sha256Hex, pkceChallenge,
} from "./oidc.mjs";

const SESSION_COOKIE = "akiba_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_MS = 10 * 60 * 1000;
const JSON_LIMIT = 8 * 1024 * 1024;

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status, message) {
  return json(status, { error: message });
}

// The two public read endpoints (GET /api/stores and /api/stores/summary)
// serve data that changes only through admin edits or the intake webhook,
// so anonymous responses are cached at the edge for a short TTL and the
// browser gets matching cache headers. Requests carrying the session
// cookie (the signed-in admin UI) always bypass the cache and read fresh
// data; everyone else may see data that is up to PUBLIC_CACHE_TTL_MS old.
const PUBLIC_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

function publicJson(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": PUBLIC_CACHE_CONTROL },
  });
}

async function publicCacheGet(request) {
  if (sessionCookieValue(request)) return null;
  if (typeof caches === "undefined") return null;
  try {
    const hit = await caches.default.match(request);
    if (!hit) return null;
    const at = Number(hit.headers.get("x-akiba-cached-at") || 0);
    if (!at || Date.now() - at > PUBLIC_CACHE_TTL_MS) return null;
    return hit;
  } catch { return null; }
}

async function publicCachePut(request, response, ctx) {
  if (sessionCookieValue(request)) return;
  if (typeof caches === "undefined") return;
  try {
    const stored = response.clone();
    stored.headers.set("x-akiba-cached-at", String(Date.now()));
    const put = caches.default.put(request, stored);
    if (ctx) ctx.waitUntil(put); else await put;
  } catch { /* the edge cache is best-effort */ }
}

// Public store reads are always filtered and paged: the whole table is
// never returned in one response. Callers narrow by station, by map
// viewport (bbox), or by id, and page with limit/offset.
const STORE_PAGE_LIMIT_MAX = 1000;
const STORE_PAGE_LIMIT_DEFAULT = 1000;

// Parses the GET /api/stores query parameters. Returns null on bad input.
function parseStoreQuery(params) {
  const q = { limit: STORE_PAGE_LIMIT_DEFAULT, offset: 0 };
  const station = params.get("station");
  if (station !== null) {
    if (!STATIONS.includes(station)) return null;
    q.station = station;
  }
  const id = params.get("id");
  if (id !== null) {
    if (!/^[0-9]{2,5}$/.test(id)) return null;
    q.id = id;
  }
  const bbox = params.get("bbox");
  if (bbox !== null) {
    const parts = bbox.split(",").map(Number);
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
    const [minLon, minLat, maxLon, maxLat] = parts;
    if (minLon > maxLon || minLat > maxLat ||
        minLon < REGION[0][0] || maxLon > REGION[1][0] ||
        minLat < REGION[0][1] || maxLat > REGION[1][1]) return null;
    q.bbox = parts;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^[0-9]+$/.test(limit)) return null;
    q.limit = Math.min(STORE_PAGE_LIMIT_MAX, Math.max(1, Number(limit)));
  }
  const offset = params.get("offset");
  if (offset !== null) {
    if (!/^[0-9]+$/.test(offset)) return null;
    q.offset = Number(offset);
  }
  return q;
}

function storeOut(row) {
  return {
    id: row.id, name: row.name, station: row.station, area: row.area, type: row.type, lat: row.lat, lon: row.lon,
    verified: row.verified === 1, source_url: row.source_url ?? null, verified_at: row.verified_at ?? null,
  };
}

// Optional Slack notification (Incoming Webhook). No-ops when
// SLACK_WEBHOOK_URL is not configured; never fails the request.
async function notifySlack(env, text) {
  if (!env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch { /* notification is best-effort */ }
}

async function secretEqual(provided, expected) {
  const [a, b] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  return a === b;
}

// Stamps verified_at when a record is (newly) verified; clears it otherwise.
function stampVerified(record, now) {
  if (record.verified) { if (!record.verified_at) record.verified_at = now; }
  else record.verified_at = null;
  return record;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > JSON_LIMIT) throw new Error("リクエストが大きすぎます。");
  return JSON.parse(text);
}

function sessionCookieValue(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

// Returns the internal account id for a valid session, or null.
async function currentAccountId(request, env) {
  const token = sessionCookieValue(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await createDb(env).sessionByHash(hash);
  if (!row || row.expires_at <= Date.now()) return null;
  return row.account_id;
}

function adminAllowed(env, accountId) {
  const list = (env.ADMIN_ACCOUNT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(accountId));
}

// Admin mutations require a session, an allowlisted account, and a matching
// Origin (CSRF defence in depth on top of the SameSite=Lax session cookie).
async function requireAdmin(request, env) {
  const accountId = await currentAccountId(request, env);
  if (accountId === null) return { error: fail(401, "ログインが必要です。") };
  if (!adminAllowed(env, accountId)) return { error: fail(403, "このアカウントには管理権限がありません。") };
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== env.APP_ORIGIN) return { error: fail(403, "Origin が一致しません。") };
  return { accountId };
}

async function handleLogin(request, env) {
  const discovery = await getDiscovery(env);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(32);
  await createDb(env).insertState(state, nonce, verifier, Date.now() + STATE_TTL_MS);
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.OIDC_CLIENT_ID,
    redirect_uri: env.APP_ORIGIN + "/auth/callback",
    scope: env.OIDC_SCOPES || "openid profile email",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return Response.redirect(url.toString(), 302);
}

async function handleCallback(request, env) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return fail(400, "認可応答が不正です。");
  const db = createDb(env);
  const saved = await db.stateById(state);
  if (!saved) return fail(400, "ログインの有効期限が切れました。もう一度ログインしてください。");
  await db.deleteState(state);
  if (saved.expires_at <= Date.now()) return fail(400, "ログインの有効期限が切れました。もう一度ログインしてください。");

  const { idToken } = await exchangeCode(env, {
    code,
    codeVerifier: saved.code_verifier,
    redirectUri: env.APP_ORIGIN + "/auth/callback",
  });
  const { sub } = await verifyIdToken(env, idToken, { audience: env.OIDC_CLIENT_ID, nonce: saved.nonce });

  // The sub stays inside this table only; the rest of the app uses the
  // internal account id.
  const accountId = await db.ensureAccount(sub, new Date().toISOString());
  if (accountId === null) throw new Error("account lookup failed");

  const token = randomToken(32);
  const now = Date.now();
  await db.insertSession(await sha256Hex(token), accountId, now + SESSION_TTL_SECONDS * 1000, new Date(now).toISOString());
  return new Response(null, {
    status: 302,
    headers: {
      location: env.APP_ORIGIN + "/#manage",
      "set-cookie": SESSION_COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + SESSION_TTL_SECONDS,
      "cache-control": "no-store",
    },
  });
}

async function handleLogout(request, env) {
  const token = sessionCookieValue(request);
  if (token) {
    await createDb(env).deleteSession(await sha256Hex(token));
  }
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": SESSION_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      "cache-control": "no-store",
    },
  });
}

async function route(request, env, ctx) {
  const db = createDb(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  // Counts only (total + per-station) for lightweight displays; the
  // response never contains store records.
  if (path === "/api/stores/summary" && method === "GET") {
    const cached = await publicCacheGet(request);
    if (cached) return cached;
    const summary = await db.storeSummary();
    const res = publicJson(200, { version: 1, total: summary.total, stations: summary.stations });
    await publicCachePut(request, res, ctx);
    return res;
  }

  if (path === "/api/stores" && method === "GET") {
    const q = parseStoreQuery(url.searchParams);
    if (!q) return fail(400, "検索条件が不正です。");
    const cached = await publicCacheGet(request);
    if (cached) return cached;
    const { total, rows } = await db.queryStores(q);
    const res = publicJson(200, { version: 1, total, limit: q.limit, offset: q.offset, stores: rows.map(storeOut) });
    await publicCachePut(request, res, ctx);
    return res;
  }

  if (path === "/api/events" && method === "POST") {
    try {
      const body = await readJson(request);
      if (!body || !/^[0-9]{2,5}$/.test(body.store_id || "") || !["view", "place", "directions"].includes(body.kind)) {
        return fail(400, "イベントが不正です。");
      }
      await db.insertEvent(body.store_id, body.kind, new Date().toISOString());
      return new Response(null, { status: 204 });
    } catch {
      return fail(400, "イベントが不正です。");
    }
  }

  // External intake: shared-secret webhook, upserts validated stores.
  // Disabled (503) until WEBHOOK_SECRET is configured.
  if (path === "/api/webhooks/stores" && method === "POST") {
    if (!env.WEBHOOK_SECRET) return fail(503, "Webhookは未設定です。");
    const provided = request.headers.get("x-webhook-secret") || "";
    if (!(await secretEqual(provided, env.WEBHOOK_SECRET))) return fail(401, "認証に失敗しました。");
    let list;
    try {
      const body = await readJson(request);
      list = Array.isArray(body) ? body : body.stores;
    } catch {
      return fail(400, "JSONが不正です。");
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > 200) {
      return fail(400, "storesは1〜200件の配列で送ってください。");
    }
    const existing = new Set(await db.listStoreIds());
    const now = new Date().toISOString();
    let accepted = 0;
    const rejected = [];
    for (let i = 0; i < list.length; i++) {
      try {
        const rec = stampVerified(validate(list[i]), now);
        if (existing.has(rec.id)) {
          await db.updateStore(rec.id, rec, now, null);
        } else {
          await db.insertStore(rec, now, null);
          existing.add(rec.id);
        }
        accepted++;
      } catch (err) {
        rejected.push({ index: i, error: err.message });
      }
    }
    if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】Webhook取り込み: " + accepted + "件反映" + (rejected.length ? " / " + rejected.length + "件却下" : "")));
    return json(200, { accepted, rejected });
  }

  if (path === "/api/admin/stats" && method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const results = await db.eventStats();
    const totals = { view: 0, place: 0, directions: 0 };
    const stores = {};
    for (const r of results) {
      (stores[r.store_id] ||= { view: 0, place: 0, directions: 0 })[r.kind] = r.n;
      totals[r.kind] += r.n;
    }
    return json(200, { totals, stores });
  }

  if (path === "/api/me" && method === "GET") {
    const accountId = await currentAccountId(request, env);
    if (accountId === null) return fail(401, "ログインが必要です。");
    return json(200, { accountId });
  }

  if (path === "/auth/login" && method === "GET") return handleLogin(request, env);
  if (path === "/auth/callback" && method === "GET") return handleCallback(request, env);
  if (path === "/auth/logout" && method === "POST") return handleLogout(request, env);

  if (path === "/api/admin/import" && method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    let rows;
    try {
      const body = await readJson(request);
      rows = validateRows(Array.isArray(body) ? body : body.stores);
    } catch (err) {
      return fail(400, err.message);
    }
    const now = new Date().toISOString();
    await db.clearStores();
    for (const r of rows) {
      stampVerified(r, now);
      await db.insertStore(r, now, auth.accountId);
    }
    if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】一括取り込み: " + rows.length + "件"));
    return json(200, { count: rows.length });
  }

  if (path === "/api/admin/stores" && method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    try {
      const body = await readJson(request);
      const ids = await db.listStoreIds();
      const now = new Date().toISOString();
      const record = stampVerified(validate({ ...body, id: nextId(ids.map((id) => ({ id }))) }), now);
      await db.insertStore(record, now, auth.accountId);
      if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】店舗を追加: " + record.name + "（" + record.id + "）"));
      return json(201, { store: record });
    } catch (err) {
      return fail(400, err.message);
    }
  }

  const storeMatch = path.match(/^\/api\/admin\/stores\/([0-9]{2,5})$/);
  if (storeMatch && (method === "PUT" || method === "DELETE")) {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const id = storeMatch[1];
    if (method === "DELETE") {
      const deleted = await db.deleteStore(id);
      if (!deleted) return fail(404, "店舗が見つかりません。");
      if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】店舗を削除: " + id));
      return json(200, { deleted: id });
    }
    try {
      const body = await readJson(request);
      const now = new Date().toISOString();
      const record = stampVerified(validate({ ...body, id }), now);
      const updated = await db.updateStore(id, record, now, auth.accountId);
      if (!updated) return fail(404, "店舗が見つかりません。");
      if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】店舗を更新: " + record.name + "（" + id + "）"));
      return json(200, { store: record });
    } catch (err) {
      return fail(400, err.message);
    }
  }

  if (path.startsWith("/api/") || path.startsWith("/auth/")) return fail(404, "見つかりません。");
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return fail(404, "見つかりません。");
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(err);
      return fail(500, "サーバーで問題が発生しました。");
    }
  },
};
