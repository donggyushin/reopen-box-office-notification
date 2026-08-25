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

Three pages plus one shared script:

```
index.html   회원가입   ─┐
login.html   로그인     ─┴─→ auth.js → home.html
home.html    로그인 후 화면
```

`auth.js` is the whole application layer. The non-obvious part is
**`setupCredentialForm()` is a DOM contract, not a component.** `index.html` and
`login.html` are near-identical documents that each declare the same fixed element IDs —
`auth-form`, `email`, `password`, `submit`, `message` — and then call
`setupCredentialForm()` with only what differs (endpoint path, minimum password length,
pending message). Renaming any of those IDs in one page silently breaks that page only.
A new credential-style page should copy the same IDs rather than parameterize them.

Both endpoints return the same success shape, so signup and login converge on one path:
store tokens, go to `home.html`. `home.html` is the guard — no `accessToken` in
`localStorage` means redirect to `login.html`.

`readEmail()` base64-decodes the JWT payload for display only. Signature verification is
the server's job; never treat the decoded contents as trusted.

## Backend

`API_BASE` at the top of `auth.js` is the only place the backend URL appears.

| | 요청 | 성공 |
|---|---|---|
| 회원가입 | `POST /users` `{ email, password }` | `201` `{ accessToken, refreshToken }` |
| 로그인 | `POST /users/login` `{ email, password }` | `201` `{ accessToken, refreshToken }` |

Errors come back as `{ message, error, statusCode }` where **`message` is either a string
or an array** of validation strings. `messageFrom()` in `auth.js` handles both; anything
new that reads an error response must too.

The backend is on a personal domain that is blocked from the office network. Probing
`api.donggyu-world.com` returns a proxy "Web Page Blocked" 503 — that is the network,
not the service. The Railway URL in `API_BASE` is reachable.

## Known gaps

- `refreshToken` is stored but never used; there is no refresh logic, so an expired
  accessToken (1h) forces a re-login.
- Tokens live in `localStorage`, so any XSS exposes them.
- `GET /users` on the backend returns every user's email without authentication.
