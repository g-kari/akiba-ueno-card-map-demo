"use strict";
// akiba-card-map worker: serves the static frontend (Workers Static Assets),
// the public store API, 0g0-id login (authorization code + PKCE), and the
// login-protected admin API. Store data lives in D1; the browser no longer
// keeps its own copy.
//
// Standing rule (same as Hyo/Kosu): the OIDC `sub` is kept only inside the
// accounts table. Everything shown to the browser or returned by the API
// uses the internal account id instead.

import { validate, validateRows, nextId } from "./store-validation.mjs";
import {
  getDiscovery, exchangeCode, verifyIdToken,
  randomToken, sha256Hex, pkceChallenge,
} from "./oidc.mjs";

const SESSION_COOKIE = "akiba_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_MS = 10 * 60 * 1000;
const JSON_LIMIT = 8 * 1024 * 1024;

const SQL = {
  listStores: "SELECT id, name, station, area, type, lat, lon, verified, source_url, verified_at FROM stores ORDER BY id",
  insertStore: "INSERT INTO stores (id, name, station, area, type, lat, lon, verified, source_url, verified_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  updateStore: "UPDATE stores SET name = ?, station = ?, area = ?, type = ?, lat = ?, lon = ?, verified = ?, source_url = ?, verified_at = ?, updated_at = ?, updated_by = ? WHERE id = ?",
  deleteStore: "DELETE FROM stores WHERE id = ?",
  clearStores: "DELETE FROM stores",
  accountBySub: "SELECT id FROM accounts WHERE sub = ?",
  insertAccount: "INSERT OR IGNORE INTO accounts (sub, created_at) VALUES (?, ?)",
  insertState: "INSERT INTO oauth_states (state, nonce, code_verifier, expires_at) VALUES (?, ?, ?, ?)",
  stateById: "SELECT nonce, code_verifier, expires_at FROM oauth_states WHERE state = ?",
  deleteState: "DELETE FROM oauth_states WHERE state = ?",
  insertSession: "INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  sessionByHash: "SELECT account_id, expires_at FROM sessions WHERE token_hash = ?",
  deleteSession: "DELETE FROM sessions WHERE token_hash = ?",
  insertEvent: "INSERT INTO events (store_id, kind, created_at) VALUES (?, ?, ?)",
  eventStats: "SELECT store_id, kind, COUNT(*) AS n FROM events GROUP BY store_id, kind",
};

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status, message) {
  return json(status, { error: message });
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
  const row = await env.DB.prepare(SQL.sessionByHash).bind(hash).first();
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
  await env.DB.prepare(SQL.insertState)
    .bind(state, nonce, verifier, Date.now() + STATE_TTL_MS)
    .run();
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
  const saved = await env.DB.prepare(SQL.stateById).bind(state).first();
  if (!saved) return fail(400, "ログインの有効期限が切れました。もう一度ログインしてください。");
  await env.DB.prepare(SQL.deleteState).bind(state).run();
  if (saved.expires_at <= Date.now()) return fail(400, "ログインの有効期限が切れました。もう一度ログインしてください。");

  const { idToken } = await exchangeCode(env, {
    code,
    codeVerifier: saved.code_verifier,
    redirectUri: env.APP_ORIGIN + "/auth/callback",
  });
  const { sub } = await verifyIdToken(env, idToken, { audience: env.OIDC_CLIENT_ID, nonce: saved.nonce });

  // The sub stays inside this table only; the rest of the app uses the
  // internal account id.
  await env.DB.prepare(SQL.insertAccount).bind(sub, new Date().toISOString()).run();
  const account = await env.DB.prepare(SQL.accountBySub).bind(sub).first();
  if (!account) throw new Error("account lookup failed");

  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(SQL.insertSession)
    .bind(await sha256Hex(token), account.id, now + SESSION_TTL_SECONDS * 1000, new Date(now).toISOString())
    .run();
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
    await env.DB.prepare(SQL.deleteSession).bind(await sha256Hex(token)).run();
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
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/api/stores" && method === "GET") {
    const { results } = await env.DB.prepare(SQL.listStores).all();
    return json(200, { version: 1, stores: results.map(storeOut) });
  }

  if (path === "/api/events" && method === "POST") {
    try {
      const body = await readJson(request);
      if (!body || !/^[0-9]{2,5}$/.test(body.store_id || "") || !["view", "place", "directions"].includes(body.kind)) {
        return fail(400, "イベントが不正です。");
      }
      await env.DB.prepare(SQL.insertEvent).bind(body.store_id, body.kind, new Date().toISOString()).run();
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
    const { results } = await env.DB.prepare(SQL.listStores).all();
    const existing = new Set(results.map((r) => r.id));
    const now = new Date().toISOString();
    let accepted = 0;
    const rejected = [];
    for (let i = 0; i < list.length; i++) {
      try {
        const rec = stampVerified(validate(list[i]), now);
        const args = [rec.name, rec.station, rec.area, rec.type, rec.lat, rec.lon, rec.verified ? 1 : 0, rec.source_url, rec.verified_at, now, null];
        if (existing.has(rec.id)) {
          await env.DB.prepare(SQL.updateStore).bind(...args, rec.id).run();
        } else {
          await env.DB.prepare(SQL.insertStore).bind(rec.id, ...args).run();
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
    const { results } = await env.DB.prepare(SQL.eventStats).all();
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
    await env.DB.prepare(SQL.clearStores).run();
    for (const r of rows) {
      stampVerified(r, now);
      await env.DB.prepare(SQL.insertStore)
        .bind(r.id, r.name, r.station, r.area, r.type, r.lat, r.lon, r.verified ? 1 : 0, r.source_url, r.verified_at, now, auth.accountId)
        .run();
    }
    if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】一括取り込み: " + rows.length + "件"));
    return json(200, { count: rows.length });
  }

  if (path === "/api/admin/stores" && method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    try {
      const body = await readJson(request);
      const { results } = await env.DB.prepare(SQL.listStores).all();
      const now = new Date().toISOString();
      const record = stampVerified(validate({ ...body, id: nextId(results) }), now);
      await env.DB.prepare(SQL.insertStore)
        .bind(record.id, record.name, record.station, record.area, record.type, record.lat, record.lon, record.verified ? 1 : 0, record.source_url, record.verified_at, now, auth.accountId)
        .run();
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
      const res = await env.DB.prepare(SQL.deleteStore).bind(id).run();
      if (!res.meta || res.meta.changes === 0) return fail(404, "店舗が見つかりません。");
      if (ctx) ctx.waitUntil(notifySlack(env, "【akiba地図】店舗を削除: " + id));
      return json(200, { deleted: id });
    }
    try {
      const body = await readJson(request);
      const now = new Date().toISOString();
      const record = stampVerified(validate({ ...body, id }), now);
      const res = await env.DB.prepare(SQL.updateStore)
        .bind(record.name, record.station, record.area, record.type, record.lat, record.lon, record.verified ? 1 : 0, record.source_url, record.verified_at, now, auth.accountId, id)
        .run();
      if (!res.meta || res.meta.changes === 0) return fail(404, "店舗が見つかりません。");
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
