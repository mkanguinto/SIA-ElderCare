# Token security and secret management (v2 · Batch 2)

This answers evaluation item 7 ("JWT: no revocation, refresh rotation, key rotation, secret management").
Code: `api-gateway/src/auth/tokenService.js`, `tokenStore.js`, `routes/oauth.js`, `shared/secrets.js`.
Tests: `api-gateway/test/tokenSecurity.test.js`, `testing/e2e-smoke.mjs`, Postman folder *7. v2 Batch 2*.

## 1. Token lifecycle

| Token | Lifetime | Signed with | Claims of note |
|---|---|---|---|
| Access | `JWT_ACCESS_TTL` (15 min) | active access key (`kid` in the header) | `sub`, `role`, `patients`, `jti`, `sid` |
| Refresh | `JWT_REFRESH_TTL` (7 days, renewed on every rotation) | active refresh key (separate secret) | `sub`, `jti`, `sid` |

Every sign-in starts a **session** `sid` (a refresh-token family). Access tokens carry the same `sid`, so
ending a session also stops its access tokens immediately, not only when they expire.

```
password grant ──► session sid, refresh #1
refresh #1     ──► access + refresh #2      (#1 is now spent)
refresh #2     ──► access + refresh #3      (#2 is now spent)
refresh #1     ──► 400 invalid_grant "already used" + the whole session is revoked
```

## 2. Refresh-token rotation with reuse detection

* Each refresh returns a **new** refresh token; the gateway remembers only the current `jti` per session.
* Presenting a spent refresh token means the token leaked or the client is broken. The gateway
  **revokes the session** (RFC 9700 §4.14.2): the attacker and the real user both have to sign in again,
  and the access tokens of that session stop working at once. The event is logged as
  `refresh token reuse detected, session revoked`.
* **Grace window** (`REFRESH_REUSE_GRACE_SECONDS`, default 10): if the *immediately previous* token is
  presented within a few seconds of a rotation (two browser tabs or parallel requests refreshing at the
  same moment), the caller receives the current token instead of being treated as an attacker. The web
  client also shares a single in-flight refresh between parallel requests (`frontend/web/src/api.js`).

## 3. Revocation

| How | Effect |
|---|---|
| `POST /oauth/revoke {token, token_type_hint?}` (RFC 7009) | refresh token → ends its session; access token → its `jti` goes on the deny-list until it expires. Always `200`, so it cannot be used to test whether a token is valid. |
| `POST /oauth/logout` (Bearer access token) | deny-lists that access token and ends its session → `204`. The web app's **Sign out** calls `/oauth/revoke` with the refresh token. |
| `POST /api/admin/users/:id/revoke-sessions` (admin) | every token issued to that user before now is rejected and all their sessions end (lost phone, role change, offboarding). |

The authentication middleware rejects a token whose `jti` is deny-listed, whose session has ended, or
which was issued before an admin revocation (`401 invalid_token`).

**Token store.** Deny-list entries and sessions are kept until the tokens they guard expire, then
pruned. They are written to `TOKEN_STORE_FILE` (Docker: the `gateway-state` volume,
`/app/state/token-store.json`, mode 600), so restarting the gateway does not bring revoked tokens back.
The store is per gateway instance; running several gateway replicas requires a shared store (Redis or
PostgreSQL) behind the same `TokenStore` interface.

## 4. Signing keys: `kid` and rotation schedule

Every token header carries a `kid`. The gateway keeps a keyring:

* **active key** (`JWT_KID` + `JWT_SECRET`, or `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` for RS256) signs new tokens;
* **previous keys** (`JWT_PREVIOUS_KEYS='{"k1":"<old secret>"}'`) only verify, so tokens signed before a
  rotation stay valid until they expire;
* a token with an unknown or retired `kid` is rejected.

Refresh tokens have their own ring (`JWT_REFRESH_KID`, `JWT_PREVIOUS_REFRESH_KEYS`).

**Schedule:** rotate every `JWT_KEY_ROTATION_DAYS` (90). `GET /api/admin/security` shows the active and
verify-only kids, `activeSince` (`JWT_KEY_ROTATED_AT`), `nextRotationDue` and `overdue`. It never returns key
material.

**Procedure (no one is signed out):**

1. Generate a new secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
2. Move the current key to the verify-only list and activate the new one:
   ```
   JWT_PREVIOUS_KEYS={"k1":"<current JWT_SECRET>"}
   JWT_KID=k2
   JWT_SECRET=<new secret>
   JWT_KEY_ROTATED_AT=<today>
   ```
3. Restart the gateway: new tokens use `k2`, existing `k1` tokens keep working.
4. After one access-token lifetime (15 min) remove `k1` from `JWT_PREVIOUS_KEYS`. For the refresh ring,
   wait one refresh lifetime (7 days) before removing the old refresh key.

If a key leaks, skip step 4's waiting: remove the leaked kid right away (its tokens become invalid at
once) and, if needed, revoke sessions per user.

## 5. Secret management (`*_FILE` / Docker secrets)

Every service calls `loadFileSecrets()` (`shared/secrets.js`) at start-up. For each known secret
`NAME`, a `NAME_FILE=/run/secrets/name` variable makes the service read the value from that file, and the
file wins over the plain variable. Supported: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `JWT_PREVIOUS_KEYS`, `JWT_PREVIOUS_REFRESH_KEYS`, `INTERNAL_SERVICE_TOKEN`,
`DATABASE_URL`, `AMQP_URL`, `TEXTBEE_API_KEY`, `TEXTBEE_WEBHOOK_SECRET`, `OPENWEATHER_API_KEY`,
`LEGACY_EMR_PASSWORD`.

```bash
npm run secrets:generate     # ./secrets/jwt_secret, jwt_refresh_secret, internal_service_token (git-ignored, mode 600)
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d --build
```

Docker secrets are mounted read-only under `/run/secrets` and do not appear in `docker inspect` or in the
image, unlike environment variables. On a Linux host the files must be readable by the container user
(`node`, uid 1000). Verified locally: the full smoke test passes in this mode and the issued tokens are
signed with the secret from the file.
