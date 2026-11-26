"use strict";
// OIDC client for 0g0-id (authorization code flow + PKCE S256, public client).
// Ported from the Kosu/Hyo implementation pattern: discovery is pinned to the
// issuer origin, endpoints must be https on that same origin, redirects are
// never followed, and ID tokens are verified against the issuer JWKS (ES256)
// with iss / aud / exp / iat / nonce checks. No client secret is ever sent
// (token_endpoint_auth_method "none").

const OIDC_BODY_LIMIT = 64 * 1024;
const JWT_MAX_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;

let discoveryCache = null;
let jwksCache = null;

export function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function assertPinnedOidcUrl(issuer, endpoint) {
  const issuerUrl = new URL(issuer);
  const endpointUrl = new URL(endpoint);
  if (issuerUrl.protocol !== "https:" || endpointUrl.protocol !== "https:") {
    throw new Error("OIDC URLs must use https");
  }
  if (issuerUrl.username || issuerUrl.password || endpointUrl.username || endpointUrl.password) {
    throw new Error("OIDC URLs must not include credentials");
  }
  if (issuerUrl.pathname !== "/" && issuerUrl.pathname !== "") {
    throw new Error("OIDC issuer must not include a path");
  }
  if (issuerUrl.origin === "null" || endpointUrl.origin !== issuerUrl.origin) {
    throw new Error("OIDC endpoint is not on the issuer origin");
  }
}

async function fetchNoRedirect(url, init) {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (res.status >= 300 && res.status < 400) {
    if (res.body) await res.body.cancel();
    throw new Error("OIDC endpoint returned a redirect");
  }
  return res;
}

async function readOidcJson(res) {
  const text = await res.text();
  if (text.length > OIDC_BODY_LIMIT) throw new Error("OIDC response too large");
  return JSON.parse(text);
}

export async function getDiscovery(env) {
  const issuer = env.OIDC_ISSUER.replace(/\/+$/, "");
  if (discoveryCache && discoveryCache.issuer === issuer) return discoveryCache.doc;
  assertPinnedOidcUrl(issuer, issuer + "/.well-known/openid-configuration");
  const res = await fetchNoRedirect(issuer + "/.well-known/openid-configuration");
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    throw new Error("OIDC discovery failed: " + res.status);
  }
  const raw = await readOidcJson(res);
  const doc = {
    issuer,
    authorization_endpoint: raw.authorization_endpoint,
    token_endpoint: raw.token_endpoint,
    jwks_uri: raw.jwks_uri,
  };
  assertPinnedOidcUrl(doc.issuer, doc.authorization_endpoint);
  assertPinnedOidcUrl(doc.issuer, doc.token_endpoint);
  assertPinnedOidcUrl(doc.issuer, doc.jwks_uri);
  discoveryCache = { issuer, doc };
  return doc;
}

async function getJwks(env) {
  const discovery = await getDiscovery(env);
  const now = Date.now();
  if (jwksCache && jwksCache.uri === discovery.jwks_uri && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetchNoRedirect(discovery.jwks_uri);
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    throw new Error("JWKS fetch failed: " + res.status);
  }
  const doc = await readOidcJson(res);
  jwksCache = { uri: discovery.jwks_uri, keys: doc.keys, fetchedAt: now };
  return doc.keys;
}

function decodeJsonPart(part) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  } catch {
    throw new Error("malformed JWT");
  }
}

// Verify an ID token from the configured issuer. Returns { sub, claims }.
// The sub is used only to look up / create the internal account row; it is
// never exposed to the browser or stored anywhere else.
export async function verifyIdToken(env, token, opts) {
  if (!opts.audience) throw new Error("audience is required");
  if (token.length === 0 || token.length > JWT_MAX_LENGTH) throw new Error("malformed JWT");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJsonPart(headerPart);
  const claims = decodeJsonPart(payloadPart);

  if (header.alg !== "ES256") throw new Error("unexpected JWT alg");
  if (header.crit !== undefined) throw new Error("unsupported crit");
  const typ = header.typ;
  if (typ !== undefined && typ !== "JWT" && typ !== "jwt") throw new Error("unexpected JWT typ");

  const issuer = env.OIDC_ISSUER.replace(/\/+$/, "");
  if (claims.iss !== issuer) throw new Error("issuer mismatch");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) throw new Error("token expired");
  const nbf = claims.nbf;
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf > nowSeconds)) {
    throw new Error("token not yet valid");
  }
  const iat = claims.iat;
  if (typeof iat !== "number" || !Number.isFinite(iat)) throw new Error("token has no valid iat");
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error("token issued in the future");
  if (iat > exp) throw new Error("token iat is after exp");

  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
  if (!audiences.includes(opts.audience)) throw new Error("audience mismatch");
  const azp = claims.azp;
  if (audiences.length > 1 && azp !== opts.audience) throw new Error("azp mismatch for multi-audience token");
  if (azp !== undefined && azp !== opts.audience) throw new Error("azp mismatch");
  if (opts.nonce !== undefined) {
    const claimNonce = claims.nonce;
    if (typeof claimNonce !== "string" || !timingSafeEqual(claimNonce, opts.nonce)) {
      throw new Error("nonce mismatch");
    }
  }

  const keys = await getJwks(env);
  if (header.kid !== undefined && typeof header.kid !== "string") throw new Error("bad kid");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const jwk = keys.find((k) => (kid ? k.kid === kid : true) && k.kty === "EC" && k.crv === "P-256");
  if (!jwk || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("signing key not found");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(headerPart + "." + payloadPart);
  let signature;
  try {
    signature = base64UrlDecode(signaturePart);
  } catch {
    throw new Error("malformed signature");
  }
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed);
  if (!ok) throw new Error("signature verification failed");

  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 256) throw new Error("missing sub");
  return { sub, claims };
}

export async function exchangeCode(env, params) {
  const discovery = await getDiscovery(env);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: env.OIDC_CLIENT_ID,
    code_verifier: params.codeVerifier,
  });
  const res = await fetchNoRedirect(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    throw new Error("token exchange failed: " + res.status);
  }
  const json = await readOidcJson(res);
  if (typeof json.id_token !== "string" || json.id_token.length === 0 || json.id_token.length > JWT_MAX_LENGTH) {
    throw new Error("token response has no id_token");
  }
  return { idToken: json.id_token };
}
