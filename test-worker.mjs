"use strict";
// Worker tests: validation rules, the admin auth guard, and a full OIDC
// authorization-code callback against a fake D1 and a locally generated
// ES256 signing key (the IdP endpoints are stubbed; no network is used).
import worker from "./src/worker.mjs";
import { validate, validateRows, nextId } from "./src/store-validation.mjs";

let checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) throw new Error("FAILED: " + label);
}
function throws(fn, label) {
  checks++;
  try { fn(); } catch { return; }
  throw new Error("FAILED (no throw): " + label);
}

// ---------- validation ----------
const good = { id: "01", name: "見本店", station: "秋葉原", area: "外神田", type: "shop", lat: 35.7, lon: 139.77 };
ok(validate(good).name === "見本店", "validate accepts a good row");
throws(() => validate({ ...good, station: "新橋" }), "validate rejects an unknown station");
throws(() => validate({ ...good, lat: 50 }), "validate rejects out-of-region lat");
throws(() => validate({ ...good, verified: true }), "validate rejects verified without a source URL");
ok(validate({ ...good, verified: true, source_url: "https://example.com/shop" }).verified === true, "validate accepts verified with a source URL");
throws(() => validate({ ...good, name: "  " }), "validate rejects a blank name");
throws(() => validateRows([good, good]), "validateRows rejects duplicate ids");
ok(nextId([{ ...good, id: "00001" }, { ...good, id: "00003" }]) === "00002", "nextId picks the smallest unused id");

// ---------- fake D1 ----------
function fakeDb(seedStores) {
  const db = {
    stores: seedStores.map((r) => ({ ...r })),
    events: [],
    accounts: [],
    sessions: new Map(),
    states: new Map(),
    nextAccountId: 1,
  };
  function stmt(sql, args) {
    return {
      async run() {
        if (sql.startsWith("INSERT INTO stores")) {
          const [id, name, station, area, type, lat, lon, verified, source_url, verified_at, updated_at, updated_by] = args;
          db.stores.push({ id, name, station, area, type, lat, lon, verified, source_url, verified_at, updated_at, updated_by });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO events")) {
          db.events.push({ store_id: args[0], kind: args[1], created_at: args[2] });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE stores")) {
          const [name, station, area, type, lat, lon, verified, source_url, verified_at, updated_at, updated_by, id] = args;
          const row = db.stores.find((r) => r.id === id);
          if (!row) return { meta: { changes: 0 } };
          Object.assign(row, { name, station, area, type, lat, lon, verified, source_url, verified_at, updated_at, updated_by });
          return { meta: { changes: 1 } };
        }
        if (sql === "DELETE FROM stores WHERE id = ?") {
          const before = db.stores.length;
          db.stores = db.stores.filter((r) => r.id !== args[0]);
          return { meta: { changes: before - db.stores.length } };
        }
        if (sql === "DELETE FROM stores") { db.stores = []; return { meta: { changes: 0 } }; }
        if (sql.startsWith("INSERT OR IGNORE INTO accounts")) {
          if (!db.accounts.some((a) => a.sub === args[0])) {
            db.accounts.push({ id: db.nextAccountId++, sub: args[0], created_at: args[1] });
          }
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO oauth_states")) {
          db.states.set(args[0], { nonce: args[1], code_verifier: args[2], expires_at: args[3] });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM oauth_states")) { db.states.delete(args[0]); return { meta: { changes: 1 } }; }
        if (sql.startsWith("INSERT INTO sessions")) {
          db.sessions.set(args[0], { account_id: args[1], expires_at: args[2], created_at: args[3] });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM sessions")) { db.sessions.delete(args[0]); return { meta: { changes: 1 } }; }
        throw new Error("fake D1: unhandled run SQL: " + sql);
      },
      async first() {
        if (sql.startsWith("SELECT id FROM accounts")) return db.accounts.find((a) => a.sub === args[0]) ?? null;
        if (sql.startsWith("SELECT nonce, code_verifier")) return db.states.get(args[0]) ?? null;
        if (sql.startsWith("SELECT account_id, expires_at FROM sessions")) return db.sessions.get(args[0]) ?? null;
        throw new Error("fake D1: unhandled first SQL: " + sql);
      },
      async all() {
        if (sql.startsWith("SELECT id, name, station")) {
          return { results: [...db.stores].sort((a, b) => a.id.localeCompare(b.id)) };
        }
        if (sql.includes("FROM events")) {
          const map = new Map();
          for (const e of db.events) {
            const key = e.store_id + "|" + e.kind;
            map.set(key, (map.get(key) || 0) + 1);
          }
          return { results: [...map.entries()].map(([key, n]) => { const [store_id, kind] = key.split("|"); return { store_id, kind, n }; }) };
        }
        throw new Error("fake D1: unhandled all SQL: " + sql);
      },
    };
  }
  db.prepare = (sql) => ({ bind: (...args) => stmt(sql, args), ...stmt(sql, []) });
  return db;
}

const ORIGIN = "https://akiba.0g0.xyz";
const seed = [
  { id: "01", name: "一号店", station: "秋葉原", area: "外神田", type: "shop", lat: 35.7002, lon: 139.7708 },
  { id: "02", name: "二号店", station: "上野", area: "東上野", type: "play", lat: 35.7107, lon: 139.7787 },
];
const db = fakeDb(seed);
const env = {
  DB: db,
  ASSETS: { fetch: async () => new Response("asset-body") },
  APP_ORIGIN: ORIGIN,
  OIDC_ISSUER: "https://id.0g0.xyz",
  OIDC_CLIENT_ID: "test-client-id",
  OIDC_SCOPES: "openid profile email",
};
const call = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);

// ---------- public API + auth guard ----------
{
  const res = await call("/api/stores");
  const body = await res.json();
  ok(res.status === 200 && body.stores.length === 2, "GET /api/stores returns the seeded stores");

  const me = await call("/api/me");
  ok(me.status === 401, "GET /api/me without a session is 401");

  const create = await call("/api/admin/stores", { method: "POST", body: JSON.stringify(good) });
  ok(create.status === 401, "POST /api/admin/stores without a session is 401");
}

// ---------- OIDC: stub the IdP, sign a real ES256 ID token ----------
const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
publicJwk.kid = "test-key-1";
const SUB = "pairwise-sub-for-test-0001";
let pendingNonce = null;

function b64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signIdToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    iss: "https://id.0g0.xyz", aud: "test-client-id", sub: SUB,
    exp: now + 600, iat: now, nonce: pendingNonce,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(header + "." + payload));
  return header + "." + payload + "." + b64u(new Uint8Array(sig));
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === "https://id.0g0.xyz/.well-known/openid-configuration") {
    return Response.json({
      issuer: "https://id.0g0.xyz",
      authorization_endpoint: "https://id.0g0.xyz/auth/authorize",
      token_endpoint: "https://id.0g0.xyz/api/token",
      jwks_uri: "https://id.0g0.xyz/.well-known/jwks.json",
    });
  }
  if (u === "https://id.0g0.xyz/.well-known/jwks.json") return Response.json({ keys: [publicJwk] });
  if (u === "https://id.0g0.xyz/api/token") return Response.json({ id_token: await signIdToken() });
  throw new Error("unexpected fetch in test: " + u);
};

try {
  const login = await call("/auth/login");
  ok(login.status === 302, "GET /auth/login redirects");
  const location = new URL(login.headers.get("location"));
  ok(location.origin + location.pathname === "https://id.0g0.xyz/auth/authorize", "login redirects to the issuer authorize endpoint");
  ok(location.searchParams.get("client_id") === "test-client-id", "authorize URL carries the client_id");
  ok(location.searchParams.get("code_challenge_method") === "S256", "authorize URL uses PKCE S256");
  const state = location.searchParams.get("state");
  ok(state && db.states.has(state), "login stores the OAuth state server-side");
  pendingNonce = db.states.get(state).nonce;

  const callback = await call("/auth/callback?code=test-code&state=" + encodeURIComponent(state));
  ok(callback.status === 302, "GET /auth/callback redirects after login");
  ok(callback.headers.get("location") === ORIGIN + "/#manage", "callback lands on the admin view");
  const cookie = callback.headers.get("set-cookie") || "";
  ok(cookie.includes("akiba_session=") && cookie.includes("HttpOnly"), "callback sets an HttpOnly session cookie");
  ok(db.accounts.length === 1 && db.accounts[0].sub === SUB, "the sub is stored only in the accounts table");

  const sessionPair = cookie.split(";")[0];
  const me = await call("/api/me", { headers: { cookie: sessionPair } });
  const meBody = await me.json();
  ok(me.status === 200 && meBody.accountId === 1, "GET /api/me returns the internal account id");
  ok(!JSON.stringify(meBody).includes(SUB), "the sub never appears in API responses");

  const badOrigin = await call("/api/admin/stores", {
    method: "POST",
    headers: { cookie: sessionPair, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ name: "悪意店", station: "秋葉原", area: "外神田", type: "shop", lat: 35.7, lon: 139.77 }),
  });
  ok(badOrigin.status === 403, "admin mutation with a foreign Origin is 403");

  const created = await call("/api/admin/stores", {
    method: "POST",
    headers: { cookie: sessionPair, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "三号店", station: "御徒町", area: "上野", type: "retail", lat: 35.7089, lon: 139.7746 }),
  });
  const createdBody = await created.json();
  ok(created.status === 201 && createdBody.store.id === "00001", "signed-in admin can create a store (server-assigned id)");

  const invalid = await call("/api/admin/stores", {
    method: "POST",
    headers: { cookie: sessionPair, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "範囲外店", station: "秋葉原", area: "外神田", type: "shop", lat: 50, lon: 139.77 }),
  });
  ok(invalid.status === 400, "admin create with out-of-region coordinates is 400");

  const removed = await call("/api/admin/stores/00001", { method: "DELETE", headers: { cookie: sessionPair, origin: ORIGIN } });
  ok(removed.status === 200, "signed-in admin can delete a store");
  const removedAgain = await call("/api/admin/stores/00001", { method: "DELETE", headers: { cookie: sessionPair, origin: ORIGIN } });
  ok(removedAgain.status === 404, "deleting a missing store is 404");

  const logout = await call("/auth/logout", { method: "POST", headers: { cookie: sessionPair } });
  ok(logout.status === 204, "POST /auth/logout succeeds");
  const meAfter = await call("/api/me", { headers: { cookie: sessionPair } });
  ok(meAfter.status === 401, "the session is gone after logout");

  // ---------- inflow events + webhook intake ----------
  const evOk = await call("/api/events", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ store_id: "01", kind: "view" }),
  });
  ok(evOk.status === 204, "public inflow event is accepted");
  const evBad = await call("/api/events", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ store_id: "01", kind: "hack" }),
  });
  ok(evBad.status === 400, "unknown event kind is 400");

  const whOff = await call("/api/webhooks/stores", {
    method: "POST", headers: { "content-type": "application/json" }, body: "[]",
  });
  ok(whOff.status === 503, "webhook is 503 until configured");
  env.WEBHOOK_SECRET = "test-webhook-secret";
  const whBad = await call("/api/webhooks/stores", {
    method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "wrong" }, body: "[]",
  });
  ok(whBad.status === 401, "webhook rejects a wrong secret");
  const whOk = await call("/api/webhooks/stores", {
    method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "test-webhook-secret" },
    body: JSON.stringify({ stores: [
      { id: "00077", name: "Webhook店", station: "札幌", area: "札幌市中央区", type: "shop", lat: 43.07, lon: 141.35 },
      { id: "00078", name: "不正駅店", station: "新橋", area: "港区", type: "shop", lat: 35.66, lon: 139.75 },
    ] }),
  });
  const whBody = await whOk.json();
  ok(whOk.status === 200 && whBody.accepted === 1 && whBody.rejected.length === 1, "webhook upserts valid rows and reports rejected rows");
  const pub = await (await call("/api/stores")).json();
  ok(pub.stores.some((r) => r.id === "00077" && r.verified === false), "webhook store appears in the public API");
} finally {
  globalThis.fetch = realFetch;
}

console.log(checks + " checks passed");
