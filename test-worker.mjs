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
  // Applies the storeFilterSql conditions (station / id / bbox, in that
  // arg order) to the fake rows; returns the filtered rows and the args
  // that remain (limit/offset for the paged query).
  function applyStoreFilter(sql, args) {
    let rows = [...db.stores];
    let i = 0;
    if (sql.includes("station = ?")) { const v = args[i++]; rows = rows.filter((r) => r.station === v); }
    if (sql.includes("id = ?")) { const v = args[i++]; rows = rows.filter((r) => r.id === v); }
    if (sql.includes("lon >= ?")) {
      const [minLon, maxLon, minLat, maxLat] = args.slice(i, i + 4); i += 4;
      rows = rows.filter((r) => r.lon >= minLon && r.lon <= maxLon && r.lat >= minLat && r.lat <= maxLat);
    }
    return { rows, rest: args.slice(i) };
  }
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
        if (sql.startsWith("SELECT COUNT(*) AS n FROM stores")) return { n: applyStoreFilter(sql, args).rows.length };
        if (sql.startsWith("SELECT id FROM accounts")) return db.accounts.find((a) => a.sub === args[0]) ?? null;
        if (sql.startsWith("SELECT nonce, code_verifier")) return db.states.get(args[0]) ?? null;
        if (sql.startsWith("SELECT account_id, expires_at FROM sessions")) return db.sessions.get(args[0]) ?? null;
        throw new Error("fake D1: unhandled first SQL: " + sql);
      },
      async all() {
        if (sql.startsWith("SELECT COUNT(*) AS n FROM stores")) {
          return { results: [{ n: applyStoreFilter(sql, args).rows.length }] };
        }
        if (sql.startsWith("SELECT id, name, station")) {
          const { rows, rest } = applyStoreFilter(sql, args);
          const sorted = rows.sort((a, b) => a.id.localeCompare(b.id));
          if (sql.includes("LIMIT ? OFFSET ?")) {
            const [limit, offset] = rest;
            return { results: sorted.slice(offset, offset + limit) };
          }
          return { results: sorted };
        }
        if (sql.startsWith("SELECT id FROM stores")) {
          return { results: [...db.stores].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ id: r.id })) };
        }
        if (sql.startsWith("SELECT station, COUNT(*)")) {
          const map = new Map();
          for (const r of db.stores) map.set(r.station, (map.get(r.station) || 0) + 1);
          return { results: [...map.entries()].map(([station, n]) => ({ station, n })) };
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
  // D1 batch(): every statement resolves like .all() and the results come
  // back as one array, in order.
  db.batch = async (stmts) => Promise.all(stmts.map((s) => s.all()));
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

// ---------- filtered / paged public reads + summary ----------
// Seed state here: 01 （秋葉原, 35.7002, 139.7708), 02 （上野, 35.7107, 139.7787).
{
  const byStation = await (await call("/api/stores?station=" + encodeURIComponent("秋葉原"))).json();
  ok(byStation.total === 1 && byStation.stores.length === 1 && byStation.stores[0].id === "01", "station filter returns only that station, with its total");
  const badStation = await call("/api/stores?station=" + encodeURIComponent("新橋"));
  ok(badStation.status === 400, "an unknown station is 400");

  const inBox = await (await call("/api/stores?bbox=139.76,35.69,139.775,35.705")).json();
  ok(inBox.total === 1 && inBox.stores[0].id === "01", "bbox returns only the stores inside the box");
  const outBox = await (await call("/api/stores?bbox=139.70,35.65,139.71,35.66")).json();
  ok(outBox.total === 0 && outBox.stores.length === 0, "a bbox away from every store is empty");
  const invertedBox = await call("/api/stores?bbox=139.78,35.69,139.77,35.70");
  ok(invertedBox.status === 400, "an inverted bbox is 400");
  const wideBox = await call("/api/stores?bbox=100,20,150,50");
  ok(wideBox.status === 400, "a bbox outside the region is 400");

  const page1 = await (await call("/api/stores?limit=1&offset=0")).json();
  const page2 = await (await call("/api/stores?limit=1&offset=1")).json();
  ok(page1.total === 2 && page1.stores.length === 1 && page2.stores.length === 1 && page1.stores[0].id !== page2.stores[0].id, "limit/offset pages through the result with a stable total");
  const capped = await (await call("/api/stores?limit=99999")).json();
  ok(capped.limit === 1000 && capped.stores.length === 2, "limit is capped at 1000");
  const badLimit = await call("/api/stores?limit=abc");
  ok(badLimit.status === 400, "a non-numeric limit is 400");

  const byId = await (await call("/api/stores?id=02")).json();
  ok(byId.total === 1 && byId.stores[0].id === "02", "id filter returns exactly that store");
  const badId = await call("/api/stores?id=abc");
  ok(badId.status === 400, "a malformed id is 400");

  const summaryRes = await call("/api/stores/summary");
  const summary = await summaryRes.json();
  ok(summaryRes.status === 200 && summary.total === 2 && !("stores" in summary), "summary returns counts only, no store records");
  const aki = summary.stations.find((s) => s.station === "秋葉原");
  const ueno = summary.stations.find((s) => s.station === "上野");
  ok(summary.stations.length === 2 && aki && aki.n === 1 && ueno && ueno.n === 1, "summary counts per station");
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

// ---------- DB provider switching (memory provider, no D1 binding) ----------
{
  const memEnv = {
    DB_PROVIDER: "memory",
    ASSETS: { fetch: async () => new Response("asset-body") },
    APP_ORIGIN: ORIGIN,
    OIDC_ISSUER: "https://id.0g0.xyz",
    OIDC_CLIENT_ID: "test-client-id",
    OIDC_SCOPES: "openid profile email",
    WEBHOOK_SECRET: "mem-secret",
  };
  const memCall = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), memEnv);
  const empty = await (await memCall("/api/stores")).json();
  ok(empty.stores.length === 0, "memory provider starts empty without a D1 binding");
  const wh = await memCall("/api/webhooks/stores", {
    method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "mem-secret" },
    body: JSON.stringify({ stores: [{ id: "00042", name: "メモリ店", station: "那覇", area: "那覇市", type: "shop", lat: 26.21, lon: 127.67 }] }),
  });
  ok(wh.status === 200, "webhook works on the memory provider");
  const filled = await (await memCall("/api/stores")).json();
  ok(filled.stores.length === 1 && filled.stores[0].id === "00042", "memory provider keeps webhook stores");
  const ev = await memCall("/api/events", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ store_id: "00042", kind: "place" }),
  });
  ok(ev.status === 204, "events work on the memory provider");
  const memSummary = await (await memCall("/api/stores/summary")).json();
  ok(memSummary.total === 1 && memSummary.stations.length === 1 && memSummary.stations[0].station === "那覇" && memSummary.stations[0].n === 1, "summary works on the memory provider");
  const memStation = await (await memCall("/api/stores?station=" + encodeURIComponent("那覇"))).json();
  ok(memStation.total === 1 && memStation.stores[0].id === "00042", "station filter works on the memory provider");
  const memBox = await (await memCall("/api/stores?bbox=130,25,135,30")).json();
  ok(memBox.total === 0 && memBox.stores.length === 0, "bbox filter works on the memory provider");
  const memId = await (await memCall("/api/stores?id=00042")).json();
  ok(memId.total === 1, "id filter works on the memory provider");
}

console.log(checks + " checks passed");
