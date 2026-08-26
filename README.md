# reopen-box-office-notification

회원가입 / 로그인 페이지. 빌드 도구 없이 HTML/CSS/JS 파일만으로 동작합니다.

```
login.html          로그인 (첫 화면, `/`)
signup.html         회원가입
home.html           로그인 후 화면
verification.html   이메일 인증 (메일 링크로 진입)
password.html       비밀번호 재설정 (코드 요청 → 인증 → 변경)
auth.js             API 호출, 토큰 저장, 폼 처리 (전 페이지 공용)
style.css           스타일
vercel.json         / → /login.html, /email/verification/:code → /verification.html rewrite
serve.py            로컬 확인용 정적 서버 (캐시 없음)
```

첫 화면은 로그인입니다. `index.html`은 없고 `/`는 `vercel.json`의 rewrite로
`login.html`을 내보냅니다. 회원가입은 그 아래 "계정 만들기" 링크로 들어갑니다.

가입이나 로그인에 성공하면 토큰을 `localStorage`에 저장하고 `home.html`로 이동합니다.
이미 토큰을 들고 있는 사람이 로그인이나 회원가입 화면을 열면 폼을 그리지 않고 바로
홈으로 보냅니다 — 홈이 토큰이 없을 때 로그인으로 되돌리는 것과 같은 기준(`hasSession()`)을
반대 방향으로 씁니다.

`home.html`은 `GET /users/me`로 내 상태를 불러와 이메일 인증과 재개봉 알림 두 줄만
보여주고, 토큰이 없거나 재발급까지 실패하면 `login.html`로 되돌립니다. 끝난 상태는 체크
표시로, 아직인 상태는 글자로 적습니다 — 줄 이름이 이미 질문이라 "예"는 표시 하나면 되고,
"아니오" 쪽에는 할 일이 남아 있어 말이 필요합니다.

## 로컬에서 보기

```
python3 serve.py        # 포트를 바꾸려면 python3 serve.py 3000
```

후 http://localhost:8000 접속. (`file://`로 열면 API 호출이 CORS로 막힙니다.)

`python3 -m http.server`를 쓰지 마세요. 그쪽은 `Cache-Control`을 보내지 않아서 브라우저가
`auth.js`를 재검증 없이 계속 재사용합니다. 새 HTML과 옛 JS가 짝지어지면 함수가 없다는
에러만 나고 화면은 조용히 비어서, 원인을 찾기 어렵습니다. `serve.py`는 그래서 캐시를 끕니다.

이메일 인증 화면은 메일 링크와 같은 주소로 그대로 확인합니다.
http://localhost:8000/email/verification/482913 — `serve.py`가 `vercel.json`의 rewrite를
읽어 배포와 같은 규칙을 적용합니다. `verification.html?code=482913` 쿼리 형태도
여전히 받습니다.

## 배포 (Vercel)

정적 사이트라 빌드 설정은 필요 없고, `vercel.json`에 rewrite 두 줄만 있습니다.

```
npm i -g vercel
vercel          # 프리뷰 배포
vercel --prod   # 프로덕션 배포
```

Framework Preset은 "Other", Build Command와 Output Directory는 비워두면 됩니다.
GitHub 레포를 Vercel에 연결하면 push할 때마다 자동 배포됩니다.

## 백엔드 연결

`auth.js` 맨 위에서 한 번만 정합니다. 로컬에서 연 페이지(`localhost`, `127.0.0.1`)는
같은 기계에서 띄운 백엔드를 보고, 그 밖에는 배포된 쪽을 봅니다.

```js
var API_BASE = 로컬이면 "http://localhost:3000"
             : 아니면 "https://donggyu-sworld-production.up.railway.app";
```

로컬 백엔드로 붙으려면 그쪽 CORS가 `http://localhost:8000`을 허용해야 합니다.
로컬에서도 배포 백엔드를 보고 싶으면 저 분기를 잠깐 지우고 쓰세요.

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

실패 응답은 `{ message, error, statusCode }` 형태이고, `message`는 문자열이거나
검증 오류 배열(`["email must be an email", ...]`)입니다. 둘 다 화면에 그대로 표시합니다.

비밀번호 8자 제한은 서버에서 검증하며, 회원가입 폼에서도 같은 기준으로 먼저 걸러냅니다.

가입하면 메일로 `/email/verification/<코드>` 링크가 갑니다. 이 주소로 들어오면
`verification.html`이 열리면서 경로 끝의 코드를 그대로 인증 API에 보냅니다.

메일을 놓쳤다면 홈 화면에서 다시 받을 수 있습니다. `isEmailVerified`가 `false`인 사람에게만
"이메일 인증" 줄에 재발송 버튼이 붙습니다.

**인증 API에는 Bearer 토큰이 필요합니다.** 로그인하지 않은 브라우저에서 메일 링크를 열면
요청을 보내지 않고 로그인부터 안내하며, 로그인하면 그 주소로 돌아와 인증을 이어서 합니다
(`login.html?next=<경로>`).

링크가 만료됐거나 이미 쓴 코드라 인증에 실패하면, 그 화면에서 바로 인증 메일을 다시
받을 수 있습니다. 어느 경우든 나갈 링크가 하나 붙는데, 로그인 상태면 "홈으로",
아니면 "로그인"입니다.

## 비밀번호 재설정

로그인 화면의 "비밀번호를 잊으셨나요?"로 `password.html`에 들어갑니다. 세 단계가
한 페이지에 있고, 앞 단계가 끝나야 다음 칸이 나타납니다.

```
이메일 입력 → POST /users/password/verification   메일로 6자리 코드
코드 입력   → POST /users/verify/password         { email, code }
새 비밀번호 → PATCH /users/password               { email, password }
```

세 단계를 한 화면에 둔 이유는 마지막 `PATCH`가 이메일을 다시 요구하기 때문입니다.
메일 링크에서 끝나는 이메일 인증과 달리 주소를 끝까지 들고 있어야 해서, 코드를 받은
자리에서 그대로 이어 갑니다. 끝난 단계는 지워지지 않고 잠기므로 어느 주소로 보냈는지
코드를 옮겨 적는 동안에도 보입니다.

**이 세 API에는 토큰을 붙이지 않습니다.** 비밀번호를 잊은 사람은 로그인할 수 없으니
`authorizedFetch()`가 아니라 맨 `fetch`를 씁니다. 어느 단계가 `401`을 주더라도 고칠
곳은 이 페이지가 아니라 그 엔드포인트의 가드입니다.

인증 단계의 실패 응답이 두 갈래인 점에 주의하세요. 코드가 틀리면 실패가 아니라
`201 { success: false }`가 오고 문구는 한 줄도 실려 있지 않아 화면 문장을 우리가 씁니다.
나머지 실패(`401 인증에 실패하였습니다.`, `409 이미 인증된 코드입니다.`)는 서버 문구가
정확하므로 그대로 보여 줍니다. 그래서 `result.ok`만 보면 안 되고 `success`까지 봐야 합니다.

없는 계정에 코드를 요청해도 서버는 똑같이 `201`을 줍니다. 화면은 주소가 맞는지 알 수
없으므로, 보냈다는 사실과 함께 "메일이 오지 않으면 주소를 확인하고 새로고침"을 안내합니다.

## 알아둘 점

- 토큰을 `localStorage`에 두므로 XSS가 생기면 그대로 노출됩니다. 다음 단계로 넘어갈 때
  httpOnly 쿠키를 고려해 보세요.
- accessToken이 만료되면 `ensureAccessToken()`이 `refreshToken`으로 조용히 새로 받습니다.
  재발급까지 거절되면 그때 토큰을 지우고 로그인 페이지로 돌립니다. 재발급은 페이지를
  열 때와 `authorizedFetch()`를 부를 때만 일어나므로, 탭을 열어둔 채로는 갱신되지 않습니다.
- `GET /users`가 인증 없이 전체 사용자 목록을 이메일까지 반환합니다.
- **`PATCH /users/password`가 인증 여부를 확인하지 않습니다.** 코드를 요청한 적도,
  인증한 적도 없이 `{ email, password }`만 보내면 그대로 `200`이 오고 그 비밀번호로
  로그인됩니다. 이메일 주소만 알면 아무 계정이나 가져갈 수 있다는 뜻이라, 앞의 두
  단계는 지금 화면상의 절차일 뿐입니다. 백엔드에서 인증된 코드를 확인해야 합니다.
- **두 인증 엔드포인트가 응답 본문에 코드를 그대로 돌려줍니다** (`{"code":"699505"}`) —
  `POST /users/password/verification`과 `POST /users/email/verification` 둘 다입니다.
  메일함에 닿지 않고도 코드를 얻을 수 있어 인증 단계가 무의미해지니 응답에서 빼야 합니다.
  `password.html`은 이 값을 읽지 않습니다 — 읽는 순간 메일 단계가 장식이 되므로
  일부러 무시합니다.
