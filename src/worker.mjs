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
const JSON_LIMIT = 300 * 1024;

const SQL = {
  listStores: "SELECT id, name, station, area, type, lat, lon FROM stores ORDER BY id",
  insertStore: "INSERT INTO stores (id, name, station, area, type, lat, lon, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  updateStore: "UPDATE stores SET name = ?, station = ?, area = ?, type = ?, lat = ?, lon = ?, updated_at = ?, updated_by = ? WHERE id = ?",
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
  return { id: row.id, name: row.name, station: row.station, area: row.area, type: row.type, lat: row.lat, lon: row.lon };
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

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/api/stores" && method === "GET") {
    const { results } = await env.DB.prepare(SQL.listStores).all();
    return json(200, { version: 1, stores: results.map(storeOut) });
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
      await env.DB.prepare(SQL.insertStore)
        .bind(r.id, r.name, r.station, r.area, r.type, r.lat, r.lon, now, auth.accountId)
        .run();
    }
    return json(200, { count: rows.length });
  }

  if (path === "/api/admin/stores" && method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    try {
      const body = await readJson(request);
      const { results } = await env.DB.prepare(SQL.listStores).all();
      const record = validate({ ...body, id: nextId(results) });
      await env.DB.prepare(SQL.insertStore)
        .bind(record.id, record.name, record.station, record.area, record.type, record.lat, record.lon, new Date().toISOString(), auth.accountId)
        .run();
      return json(201, { store: record });
    } catch (err) {
      return fail(400, err.message);
    }
  }

  const storeMatch = path.match(/^\/api\/admin\/stores\/([0-9]{2,4})$/);
  if (storeMatch && (method === "PUT" || method === "DELETE")) {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const id = storeMatch[1];
    if (method === "DELETE") {
      const res = await env.DB.prepare(SQL.deleteStore).bind(id).run();
      if (!res.meta || res.meta.changes === 0) return fail(404, "店舗が見つかりません。");
      return json(200, { deleted: id });
    }
    try {
      const body = await readJson(request);
      const record = validate({ ...body, id });
      const res = await env.DB.prepare(SQL.updateStore)
        .bind(record.name, record.station, record.area, record.type, record.lat, record.lon, new Date().toISOString(), auth.accountId, id)
        .run();
      if (!res.meta || res.meta.changes === 0) return fail(404, "店舗が見つかりません。");
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
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error(err);
      return fail(500, "サーバーで問題が発生しました。");
    }
  },
};
