# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The frontend for a box-office reopening notification service. Static HTML/CSS/JS only —
no build step, no `package.json`, no dependencies, no test suite. Backend lives in a
separate repository and is deployed to Railway.

## Commands

There is nothing to build or install.

```
python3 -m http.server 8000    # 로컬 확인 — http://localhost:8000
vercel                          # 프리뷰 배포
vercel --prod                   # 프로덕션 배포
```

Open pages through the local server, not `file://` — the API calls are cross-origin and
`file://` requests are rejected.

There is no linter and no tests. To sanity-check a change, `node --check auth.js` catches
syntax errors, and functions in `auth.js` can be exercised in `node` by extracting them
from the file, since they are plain globals with no browser dependency except
`localStorage`/`atob`.

## Constraints that are choices, not accidents

**Keep it vanilla.** The user explicitly chose plain HTML/JS over Next.js so deploys stay
trivial and the project stays readable. Do not introduce a framework, bundler, ES modules,
TypeScript, or a package manager unless asked. `auth.js` is loaded with a plain
`<script src>` and exposes globals on purpose.

**Keep the design austere.** The target look is early-Google: Arial, black text, gray
1px borders, no shadows/gradients/animation/icons. `style.css` is element-selector-based
with a handful of classes. Resist adding visual polish.

## Architecture

Four pages plus one shared script:

```
index.html          회원가입   ─┐
login.html          로그인     ─┴─→ auth.js → home.html
home.html           로그인 후 화면
verification.html   이메일 인증 (메일 링크로 진입)
```

`auth.js` is the whole application layer. The non-obvious part is
**`setupCredentialForm()` is a DOM contract, not a component.** `index.html` and
`login.html` are near-identical documents that each declare the same fixed element IDs —
`auth-form`, `email`, `password`, `submit`, `message` — and then call
`setupCredentialForm()` with only what differs (endpoint path, minimum password length,
pending message). Renaming any of those IDs in one page silently breaks that page only.
A new credential-style page should copy the same IDs rather than parameterize them.

Both endpoints return the same success shape, so signup and login converge on one path:
store tokens, go to `home.html`. `home.html` is the guard — it redirects to `login.html`
when `localStorage` holds neither token, and again if `ensureAccessToken()` cannot
produce a live one.

`readPayload()` base64-decodes the JWT payload; `readEmail()` and `isExpired()` are the
only readers. Signature verification is the server's job; never treat the decoded
contents as trusted — `isExpired()` is a scheduling hint, not an auth check.

**Token renewal has one entry point.** `ensureAccessToken()` returns a usable
accessToken, refreshing first when the local `exp` is within `TOKEN_EXPIRY_SKEW_MS`.
`refreshTokens()` shares one in-flight promise, so concurrent callers make a single
request. It distinguishes two failures on purpose: a non-ok response means the session
is dead, so tokens are cleared; a rejected `fetch` (offline, CORS) leaves them intact.
`authorizedFetch()` wraps both — it attaches the bearer header and retries exactly once
on a 401, since the server is the authority on expiry, not the local clock. It is the
only way to call an authenticated endpoint; `setupHome()` is its one caller today.

`setupHome()` follows the same DOM contract as `setupCredentialForm()`: `home.html`
declares `greeting`, `profile`, `message`, and `logout`, and the page's whole script is
one `setupHome()` call. It paints the JWT email immediately so the page is never blank,
then overwrites it with the `/users/me` response — the token is display-only scaffolding,
the API answer is the truth. Its three failure paths are deliberately different: a 401
that survived the retry clears tokens and redirects, a non-ok response shows the server's
message and stays put, and a rejected `fetch` shows a connection error without touching
the session.

**`verification.html` is served from a path it does not live at.** The mail link is
`/email/verification/<code>`; `vercel.json` rewrites that to `/verification.html`, and
`readVerificationCode()` takes the code from the last path segment. Two consequences:
the page must reference `/auth.js` and `/style.css` with absolute paths (relative ones
would resolve under `/email/verification/`), and the local `http.server` has no rewrite,
so test it as `verification.html?code=<code>` — the query form is the fallback branch in
`readVerificationCode()`, not a second feature.

## Backend

`API_BASE` at the top of `auth.js` is the only place the backend URL appears.

| | 요청 | 성공 |
|---|---|---|
| 회원가입 | `POST /users` `{ email, password }` | `201` `{ accessToken, refreshToken }` |
| 로그인 | `POST /users/login` `{ email, password }` | `201` `{ accessToken, refreshToken }` |
| 이메일 인증 | `POST /users/verify/email` `{ code }` | `{ success: true }` |
| 토큰 재발급 | `POST /auth/refresh-token` `{ refreshToken }` | `201` `{ accessToken, refreshToken }` |
| 내 정보 | `GET /users/me` (Bearer) | `200` `{ id, email, name, isAdmin, isEmailVerified, createdAt, receiveReopenBoxOfficeNotifications }` |

Errors come back as `{ message, error, statusCode }` where **`message` is either a string
or an array** of validation strings. `messageFrom()` in `auth.js` handles both; anything
new that reads an error response must too.

The backend is on a personal domain that is blocked from the office network. Probing
`api.donggyu-world.com` returns a proxy "Web Page Blocked" 503 — that is the network,
not the service. The Railway URL in `API_BASE` is reachable.

## Known gaps

- Refresh is pull-only: `ensureAccessToken()` renews on page load and before each
  `authorizedFetch()`, but nothing renews on a timer, so a tab left open past the 1h
  accessToken expiry only recovers on its next call.
- Tokens live in `localStorage`, so any XSS exposes them.
- `GET /users` on the backend returns every user's email without authentication.
