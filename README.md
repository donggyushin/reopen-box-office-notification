# reopen-box-office-notification

회원가입 / 로그인 페이지. 빌드 도구 없이 HTML/CSS/JS 파일만으로 동작합니다.

```
index.html   회원가입
login.html   로그인
home.html    로그인 후 화면
auth.js      API 호출, 토큰 저장, 폼 처리 (세 페이지 공용)
style.css    스타일
```

가입이나 로그인에 성공하면 토큰을 `localStorage`에 저장하고 `home.html`로 이동합니다.
`home.html`은 토큰이 없으면 `login.html`로 되돌립니다.

## 로컬에서 보기

```
python3 -m http.server 8000
```

후 http://localhost:8000 접속. (`file://`로 열면 API 호출이 CORS로 막힙니다.)

## 배포 (Vercel)

정적 사이트라 별도 설정이 필요 없습니다.

```
npm i -g vercel
vercel          # 프리뷰 배포
vercel --prod   # 프로덕션 배포
```

Framework Preset은 "Other", Build Command와 Output Directory는 비워두면 됩니다.
GitHub 레포를 Vercel에 연결하면 push할 때마다 자동 배포됩니다.

## 백엔드 연결

`auth.js` 맨 위 한 줄이 전부입니다.

```js
var API_BASE = "https://donggyu-sworld-production.up.railway.app";
```

| | 요청 | 성공 |
|---|---|---|
| 회원가입 | `POST /users` `{ email, password }` | `201` `{ accessToken, refreshToken }` |
| 로그인 | `POST /users/login` `{ email, password }` | `201` `{ accessToken, refreshToken }` |

실패 응답은 `{ message, error, statusCode }` 형태이고, `message`는 문자열이거나
검증 오류 배열(`["email must be an email", ...]`)입니다. 둘 다 화면에 그대로 표시합니다.

비밀번호 8자 제한은 서버에서 검증하며, 회원가입 폼에서도 같은 기준으로 먼저 걸러냅니다.

## 알아둘 점

- 토큰을 `localStorage`에 두므로 XSS가 생기면 그대로 노출됩니다. 다음 단계로 넘어갈 때
  httpOnly 쿠키를 고려해 보세요.
- `refreshToken`을 저장만 하고 갱신 로직은 아직 없습니다. accessToken이 만료되면
  다시 로그인해야 합니다.
- `GET /users`가 인증 없이 전체 사용자 목록을 이메일까지 반환합니다.
