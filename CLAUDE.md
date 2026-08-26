# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The frontend for a box-office reopening notification service. Static HTML/CSS/JS only —
no build step, no `package.json`, no dependencies, no test suite. Backend lives in a
separate repository and is deployed to Railway.

## Commands

There is nothing to build or install.

```
python3 serve.py               # 로컬 확인 — http://localhost:8000
vercel                          # 프리뷰 배포
vercel --prod                   # 프로덕션 배포
```

Open pages through the local server, not `file://` — the API calls are cross-origin and
`file://` requests are rejected.

**Use `serve.py`, not `python3 -m http.server`.** The stdlib server sends no
`Cache-Control`, so Chrome reuses a cached `auth.js` without revalidating. A new
`home.html` then runs against an old `auth.js`, the first call throws
`ReferenceError`, and the page goes silently blank — the symptom points at the page,
not at the cache, so it costs real time to diagnose. `serve.py` sends `no-store` and
drops conditional requests so an already-cached copy cannot come back as a 304.

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
one `setupHome()` call. The profile table is built in JS, not markup, because one row
carries a control: when `isEmailVerified` is false the "이메일 인증" cell also gets a
resend button that POSTs to `/users/email/verification`.

**The table shows two rows, not the whole `/users/me` response.** Only 이메일 인증 and
재개봉 알림 are there — the states this person can still do something about. `id`,
`name`, `createdAt`, and `isAdmin` come back from the API and are deliberately dropped,
and `email` already appears in the greeting above. Adding a field to the response should
not add a row by default. Verification finishes in the
mail link, not on this page, so the success message tells the user to reload — the page
has no way to observe the result on its own. It paints the JWT email immediately so the page is never blank,
then overwrites it with the `/users/me` response — the token is display-only scaffolding,
the API answer is the truth. Its three failure paths are deliberately different: a 401
that survived the retry clears tokens and redirects, a non-ok response shows the server's
message and stays put, and a rejected `fetch` shows a connection error without touching
the session.

**`verification.html` is served from a path it does not live at.** The mail link is
`/email/verification/<code>`; `vercel.json` rewrites that to `/verification.html`, and
`readVerificationCode()` takes the code from the last path segment. So the page must
reference `/auth.js` and `/style.css` with absolute paths — relative ones would resolve
under `/email/verification/`.

A failed code is a dead end for that link, so the page does not just report it and offer
a login link — it offers a new email. Resending needs a bearer token, so `verification.html`
splits on whether tokens exist: a signed-in visitor gets the same
`verificationEmailButton()` the home page uses, and a signed-out one is told to log in
first. A rejected `fetch` is the exception — the code may still be alive, so that path
suggests reopening the link rather than burning it.

`verificationEmailButton()` stays disabled after a send goes through, and re-enables
only when the send failed. One mail is the whole point; a second changes nothing, and
the next step is in the inbox, not on the page.

This page also breaks the "show the server's message" rule on purpose. The backend
answers an expired code with a bare `Unauthorized`, which tells a Korean user nothing, so
`#message` carries our own sentence and `#detail` keeps the server's text in small gray
type. Do not delete `#detail` — it is how a changed response shape stays visible.

`serve.py` parses the rewrites out of `vercel.json` rather than restating them, so the
mail link opens locally at the same address it does in production. Keep it that way: a
rewrite written in two places is a rewrite that will disagree with itself. The
`?code=<code>` query form still works and is the fallback branch in
`readVerificationCode()`, not a second feature.

## Backend

`API_BASE` at the top of `auth.js` is the only place a backend URL appears. It picks by
hostname: a page served from `localhost`/`127.0.0.1`/`[::1]` talks to
`http://localhost:3000`, everything else to the Railway deployment. So local pages hit a
local backend by default — pointing local at the deployed backend means editing that
branch, and a local backend must allow CORS from `http://localhost:8000`.

| | 요청 | 성공 |
|---|---|---|
| 회원가입 | `POST /users` `{ email, password }` | `201` `{ accessToken, refreshToken }` |
| 로그인 | `POST /users/login` `{ email, password }` | `201` `{ accessToken, refreshToken }` |
| 이메일 인증 | `POST /users/verify/email` `{ code }` | `{ success: true }` |
| 토큰 재발급 | `POST /auth/refresh-token` `{ refreshToken }` | `201` `{ accessToken, refreshToken }` |
| 내 정보 | `GET /users/me` (Bearer) | `200` `{ id, email, name, isAdmin, isEmailVerified, createdAt, receiveReopenBoxOfficeNotifications }` |
| 인증 메일 재발송 | `POST /users/email/verification` (Bearer, 바디 없음) | `201` |

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
