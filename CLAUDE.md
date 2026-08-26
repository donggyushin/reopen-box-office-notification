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
with a handful of classes. Resist adding visual polish. The one sanctioned exception is
the block at the bottom of `style.css` — `.check`, `.check.drawn`, `.progress`, `.pending` —
which exists only for the two profile rows. It is a deliberate accent, not the start of a
theme: an animation added anywhere else has no such warrant.

## Architecture

Five pages plus one shared script:

```
login.html          로그인      ─┐   ← /  (vercel.json rewrite)
signup.html         회원가입    ─┴─→ auth.js → home.html
home.html           로그인 후 화면
verification.html   이메일 인증 (메일 링크로 진입)
password.html       비밀번호 재설정 (login.html 에서 진입)
```

`auth.js` is the whole application layer. The non-obvious part is
**`setupCredentialForm()` is a DOM contract, not a component.** `signup.html` and
`login.html` are near-identical documents that each declare the same fixed element IDs —
`auth-form`, `email`, `password`, `submit`, `message` — and then call
`setupCredentialForm()` with only what differs (endpoint path, minimum password length,
pending message). Renaming any of those IDs in one page silently breaks that page only.
A new credential-style page should copy the same IDs rather than parameterize them.

Both endpoints return the same success shape, so signup and login converge on one path:
store tokens, go to `home.html`. `home.html` is the guard — it redirects to `login.html`
when `localStorage` holds neither token, and again if `ensureAccessToken()` cannot
produce a live one.

**There is no `index.html`; `/` is a rewrite to `/login.html`.** The first screen is the
one an unknown visitor needs, and the signup page is a link away from it rather than the
other way round. Putting login at `index.html` instead would have meant renaming the file
that `auth.js`, `password.html`, and every `?next=` link already point at, so the root is
a rewrite and every page keeps its own name. Adding a real `index.html` back would shadow
that rewrite and quietly undo this.

**The two guards are one function, pointed in opposite directions.** `hasSession()` — a
token, either one — is what `setupHome()` checks before staying and what
`setupCredentialForm()` checks before leaving: a signed-in visitor who opens `/` (or the
signup page) is sent straight to `home.html`, honouring `?next=` the same way a fresh
login does. They must keep sharing that one function, because a guard pair that disagrees
about what "signed in" means is a redirect loop. A dead token is not a loop, only one
extra hop: home fails to refresh, clears the tokens, and sends them back — and this time
the form stays. `setupEmailVerification()` asks the same question three times over, so it
now reads the global instead of the private copy it used to keep.

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
declares `reopen`, `greeting`, `profile`, `message`, `chart`, and `logout`, and the page's
whole script is one `setupHome()` call. The profile table is built in JS, not markup, because one row
carries a control: when `isEmailVerified` is false the "이메일 인증" cell also gets a
resend button that POSTs to `/users/email/verification`.

**The table shows two rows, not the whole `/users/me` response.** Only 이메일 인증 and
재개봉 알림 are there — the states this person can still do something about. `id`,
`name`, `createdAt`, and `isAdmin` come back from the API and are deliberately dropped,
and `email` already appears in the greeting above. Adding a field to the response should
not add a row by default. The 재개봉 알림 row is not a control at all: when
`isEmailVerified` is true and `receiveReopenBoxOfficeNotifications` is false, drawing the
row fires the PATCH itself. Both conditions matter — turning notifications on before the
address is verified points them at nowhere, so an unverified visitor's next step is the
row above. Verification finishes in the mail link, not on this page, so the success message tells the user to reload — the page
has no way to observe the result on its own. It paints the JWT email immediately so the page is never blank,
then overwrites it with the `/users/me` response — the token is display-only scaffolding,
the API answer is the truth. Its three failure paths are deliberately different: a 401
that survived the retry clears tokens and redirects, a non-ok response shows the server's
message and stays put, and a rejected `fetch` shows a connection error without touching
the session.

**A settled row is a check mark, not a word.** Both rows write their true state as the
drawn `checkMark()` and their false state as text — `미완료`, `받지 않음`. The asymmetry is
the point: the row label already asks the question, so a yes needs only a mark, while a no
still has work attached to it and one of those cells carries the resend button. The mark
replaces the word rather than joining it, so `aria-label` carries what was dropped.

`checkMark(label, animated)` is shared by `setupHome()` and `enableReopenNotifications()`,
and `animated` is the only difference between them. The draw animation lives on
`.check.drawn`, never on `.check`, because a value that was already true when the page
loaded must not animate — a check that draws itself says "this just happened", and on a
reload that is a lie. Only the row that genuinely just flipped gets it.

**`enableReopenNotifications()` asks nobody, and stalls on purpose.** Someone who signed
up for reopening alerts has already answered the question a confirm button would ask, so
the page does not ask it again — it PATCHes
`/users/receive-reopen-box-office-notifications` with `{ value: true }` as soon as the
row is drawn. Because nothing was clicked, the change has to be visible on its own: the
function takes over the value cell with a sweeping progress bar for a floor of 2500ms —
`MIN_PENDING_MS` — even when the server answers instantly, then settles into a drawn
checkmark and a line in `#message`. Do not shorten the floor to match the
server; a value that flips the instant the page loads reads as markup, not as something
that just happened. The floor is enforced by
`Promise.all([settled, wait(MIN_PENDING_MS)])`, where `settled` resolves to `{result}` or
`{failed}` rather than rejecting — a rejection would break `Promise.all` early and let
the failure path skip the wait. Failure leaves the cell reading "받지 않음" with the
reason in `#message` and offers no retry control: the next attempt is a reload, and this
row is not a place to press things.

**`loadBoxOffice()` is the only call on this page that carries no token.**
`GET /box-office/daily` is public, so it uses bare `fetch` rather than `authorizedFetch()`
— and the reason is not only that a bearer header would be pointless. `authorizedFetch()`
can end a session: a 401 there clears tokens and `setupHome()` redirects. Failing to draw a
ranking must never log anyone out, so this path never touches `localStorage` and never
redirects. Its failure text goes in `#chart`; `#message` belongs to the profile rows above
and would otherwise show two unrelated sentences at once. It is fired alongside
`/users/me`, not after it, so neither half of the page waits on the other.

**The bars are linear, and every one of them has its number printed beside it.** #1 outdraws
#10 by more than a hundred times, so ranks 8-10 are a 2px mark — `.chart .bar span` has a
`min-width` so a row with real audience never renders as nothing. That is the honest shape
of the day and the point of the chart; the digits in the `.count` column are what make the
bottom rows readable. Do not switch to a log scale to even them out — it would flatter the
small rows by lying about the gap.

**The reopening film is written twice on purpose.** It is highlighted in the table
(`tr.reopen` — green name, green bar, and a `재개봉` tag, because the color alone carries no
meaning for anyone who cannot see it) and written again in `#reopen` above everything else.
One row out of ten is exactly the thing this whole service exists to announce, and in the
table it has to be found. When the list holds no reopening film, `#reopen` says so in
words. It is left empty — and `#reopen:empty` hides it — only when no list arrived at all,
because "there are none today" and "we could not ask" must not look alike.

**`verification.html` is served from a path it does not live at.** The mail link is
`/email/verification/<code>`; `vercel.json` rewrites that to `/verification.html`, and
`readVerificationCode()` takes the code from the last path segment. So the page must
reference `/auth.js` and `/style.css` with absolute paths — relative ones would resolve
under `/email/verification/`.

**`/users/verify/email` is guarded, so the mail link needs a session.** The backend
answers a missing token with a bare `{"message":"Unauthorized","statusCode":401}` — no
`error` key — while a business rejection carries `error` plus a Korean sentence. That
difference is the only way to tell "you sent no token" from "that code is bad", and
sending the code without a bearer header silently produces the former. So the page checks
for tokens before it calls at all, and a signed-out visitor gets
`login.html?next=<this path>`; `readNextPath()` accepts only a single-slash same-site
path, so `//evil.com` cannot ride in through the query.

One consequence to know: a wrong code also answers 401, so `authorizedFetch()` spends a
refresh and one retry before reporting it. That is wasted work, not a bug — do not try to
skip it by sniffing the `error` key, which would couple the page to the backend's error
shape.

Every branch of this page ends with one onward link, and `addOnwardLink()` picks it from
session state: signed in goes to `home.html`, signed out goes to
`login.html?next=<this path>`. Because verifying now requires a session, a successful
verification means the visitor is already signed in — offering them "로그인" there is an
action with nothing behind it.

A failed code is a dead end for that link, so the page does not just report it and offer
a way out — it offers a new email. Resending needs a bearer token, so `verification.html`
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

**`password.html` is one page holding three steps, and that is forced by the API.**
The final `PATCH /users/password` takes `{ email, password }` — it identifies the account
by address, not by the code just verified. So unlike `verification.html`, which finishes in
the mail link and needs nothing but the code in the path, this flow has to still be holding
the email when it reaches the last request. Keeping all three steps on one page is what
keeps it in hand. `setupPasswordReset()` sends `sentEmail` — the address a code was actually
mailed to — and not `#email`'s current value; the field is locked after step 1, so today they
agree, but what gets a new password must be the address the code arrived at.

Its DOM contract is three forms, not one: `email-form`/`email`/`send`,
`code-form`/`code`/`verify`, `password-form`/`password`/`reset`, plus the shared `message`
and `detail`. Each step is its own `<form>` so Enter submits the step you are standing in.
The last two carry `hidden` in the markup and are revealed only by the step before them —
that attribute is the gate, so do not drop it to "see the whole form".

Finished steps are locked, not erased. The address has to stay readable while its code is
being copied out of the mail, and the trail is the only thing telling you how far along you are.

**None of the three calls carry a token, and that is the point.** Someone who has forgotten
their password cannot log in, so `setupPasswordReset()` uses bare `fetch` rather than
`authorizedFetch()`. If a step ever answers 401, the fix is that endpoint's guard — reaching
for `authorizedFetch()` here would build a password reset only already-logged-in people can use.

**The verify step fails in two shapes, and only one of them carries words.** A wrong code
comes back as `201 { success: false }` — success's own status, with no message anywhere in
the body — so `result.ok` alone would read it as a pass, and the sentence on screen has to be
ours. Every other failure (`401 인증에 실패하였습니다.`, `409 이미 인증된 코드입니다.`) does
carry accurate Korean, so those are shown verbatim. Hence the branch order: `ok && success`,
then `ok`, then the server's text.

`showFailure()` follows the house rule of showing the server's message, with 5xx carved out:
`Internal server error` names neither what the person did nor what to do next, so that case
alone gets our sentence with the server's text demoted to `#detail`.

**Step 1 answers `201` for addresses that have no account.** The page cannot tell a real
address from a typo, so it does not pretend to — the confirmation says a code was sent *and*
that a missing mail means checking the address and reloading. Reload is the whole retry story
here, same as elsewhere: there is no "send again" control, because a second mail to the same
address changes nothing.

**Do not read the `code` the server returns from step 1.** `POST /users/password/verification`
currently answers `{"code":"699505"}` in the response body. Wiring that into the code field
would make the page work beautifully and reduce the mail step to decoration — it is the one
value on this screen that must travel through the user's inbox.

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
| 이메일 인증 | `POST /users/verify/email` (Bearer) `{ email, code }` | `201` `{ success: true }` |
| 토큰 재발급 | `POST /auth/refresh-token` `{ refreshToken }` | `201` `{ accessToken, refreshToken }` |
| 내 정보 | `GET /users/me` (Bearer) | `200` `{ id, email, name, isAdmin, isEmailVerified, createdAt, receiveReopenBoxOfficeNotifications }` |
| 인증 메일 재발송 | `POST /users/email/verification` (Bearer, 바디 없음) | `201` |
| 재설정 코드 요청 | `POST /users/password/verification` `{ email }` | `201` |
| 재설정 코드 인증 | `POST /users/verify/password` `{ email, code }` | `201` `{ success: true }` |
| 비밀번호 변경 | `PATCH /users/password` `{ email, password }` | `200` |
| 재개봉 알림 설정 | `PATCH /users/receive-reopen-box-office-notifications` (Bearer) `{ value }` | `200` |
| 일별 박스오피스 | `GET /box-office/daily` (토큰 없음) | `200` `{ boxOfficeList: [{ rank, movieNm, openDt, audiCnt, salesShare, isReopen, ... }] }` |

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
- `PATCH /users/password` never checks that a code was verified. Sending `{ email, password }`
  with no prior request or verification returns `200`, and the account then logs in with that
  password — an email address alone is enough to take any account. Steps 1 and 2 are, as the
  backend stands, ceremony that the frontend performs and the server does not enforce.
- Both verification endpoints return their code in their own response body —
  `POST /users/password/verification` and `POST /users/email/verification` alike — so either
  code can be had without the mailbox it was meant to prove.
