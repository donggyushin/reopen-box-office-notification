// 백엔드 API 주소
var API_BASE = "https://donggyu-sworld-production.up.railway.app";

// 만료 몇 초 전부터 미리 재발급할지. 요청이 날아가는 사이에 만료되는 것을 막는다.
var TOKEN_EXPIRY_SKEW_MS = 30 * 1000;

// 진행 중인 재발급 요청. 동시 호출이 요청을 여러 번 보내지 않게 한다.
var refreshInFlight = null;

// 서버 에러 응답에서 보여줄 문구를 뽑는다.
// message는 문자열일 수도, 검증 오류 배열일 수도 있다.
function messageFrom(body, status) {
  try {
    var parsed = JSON.parse(body);
    var message = parsed.message || parsed.error;
    if (Array.isArray(message)) {
      return message.join(" ");
    }
    if (message) {
      return message;
    }
  } catch (e) {
    // JSON이 아니면 아래 기본 문구로 넘어간다.
  }
  return "요청에 실패했습니다. (" + status + ")";
}

function saveTokens(data) {
  if (!data || !data.accessToken) {
    return false;
  }
  localStorage.setItem("accessToken", data.accessToken);
  if (data.refreshToken) {
    localStorage.setItem("refreshToken", data.refreshToken);
  }
  return true;
}

function clearTokens() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
}

// JWT 페이로드를 꺼낸다.
// 서명 검증은 서버 몫이고, 여기서는 표시와 만료 판정에만 쓴다.
function readPayload(jwt) {
  try {
    var base64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    var json = decodeURIComponent(
      atob(base64)
        .split("")
        .map(function (c) {
          return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join("")
    );
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function readEmail(jwt) {
  var payload = readPayload(jwt);
  return (payload && payload.email) || "";
}

// 토큰이 만료되었는지 본다.
// 읽을 수 없는 토큰은 만료로, exp가 없는 토큰은 유효한 것으로 본다.
function isExpired(jwt) {
  var payload = readPayload(jwt);
  if (!payload) {
    return true;
  }
  if (!payload.exp) {
    return false;
  }
  return Date.now() >= payload.exp * 1000 - TOKEN_EXPIRY_SKEW_MS;
}

// refreshToken으로 토큰을 새로 받는다.
// 두 곳에서 동시에 불려도 요청은 한 번만 나가도록 진행 중인 약속을 공유한다.
function refreshTokens() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  var refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) {
    clearTokens();
    return Promise.reject(new Error("다시 로그인해 주세요."));
  }

  refreshInFlight = fetch(API_BASE + "/auth/refresh-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refreshToken })
  })
    .then(function (response) {
      return response.text().then(function (body) {
        if (!response.ok) {
          // 재발급이 거절되면 재로그인 외에 방법이 없으므로 토큰을 버린다.
          // 연결 실패는 여기로 오지 않으므로 그때는 토큰을 그대로 둔다.
          clearTokens();
          throw new Error(messageFrom(body, response.status));
        }

        var data = {};
        try {
          data = JSON.parse(body);
        } catch (e) {
          data = {};
        }

        if (!saveTokens(data)) {
          clearTokens();
          throw new Error("재발급 응답에 토큰이 없습니다.");
        }
        return data.accessToken;
      });
    })
    .then(
      function (accessToken) {
        refreshInFlight = null;
        return accessToken;
      },
      function (error) {
        refreshInFlight = null;
        throw error;
      }
    );

  return refreshInFlight;
}

// 지금 쓸 수 있는 accessToken을 돌려준다. 만료되었으면 먼저 재발급한다.
// 재발급까지 실패하면 거절하므로, 부르는 쪽이 로그인 페이지로 보내면 된다.
function ensureAccessToken() {
  var accessToken = localStorage.getItem("accessToken");

  if (accessToken && !isExpired(accessToken)) {
    return Promise.resolve(accessToken);
  }
  return refreshTokens();
}

// 로그인한 사용자용 요청.
// accessToken을 붙이고, 서버가 401을 주면 한 번만 재발급해 다시 보낸다.
function authorizedFetch(path, options) {
  var settings = options || {};

  function send(accessToken, retried) {
    var headers = {};
    var given = settings.headers || {};
    for (var key in given) {
      if (Object.prototype.hasOwnProperty.call(given, key)) {
        headers[key] = given[key];
      }
    }
    headers.Authorization = "Bearer " + accessToken;

    return fetch(API_BASE + path, {
      method: settings.method || "GET",
      headers: headers,
      body: settings.body
    }).then(function (response) {
      if (response.status !== 401 || retried) {
        return response;
      }

      // 우리 쪽 exp 계산보다 서버 판단이 먼저인 경우 — 재발급 후 한 번만 재시도한다.
      return refreshTokens().then(function (accessToken) {
        return send(accessToken, true);
      });
    });
  }

  return ensureAccessToken().then(function (accessToken) {
    return send(accessToken, false);
  });
}

// 이메일/비밀번호 폼을 API에 연결한다.
// 회원가입과 로그인이 같은 폼 구조를 쓰므로 두 페이지가 이 함수를 공유한다.
function setupCredentialForm(options) {
  var form = document.getElementById("auth-form");
  var emailInput = document.getElementById("email");
  var passwordInput = document.getElementById("password");
  var submitButton = document.getElementById("submit");
  var message = document.getElementById("message");
  var minPassword = options.minPassword || 1;

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var email = emailInput.value.trim();
    var password = passwordInput.value;

    if (!email || email.indexOf("@") === -1) {
      show("이메일 주소를 확인해 주세요.", true);
      emailInput.focus();
      return;
    }

    if (password.length < minPassword) {
      show(
        minPassword > 1
          ? "비밀번호는 " + minPassword + "자 이상이어야 합니다."
          : "비밀번호를 입력해 주세요.",
        true
      );
      passwordInput.focus();
      return;
    }

    submitButton.disabled = true;
    show(options.pendingText, false);

    fetch(API_BASE + options.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    })
      .then(function (response) {
        return response.text().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          show(messageFrom(result.body, result.status), true);
          submitButton.disabled = false;
          return;
        }

        var data = {};
        try {
          data = JSON.parse(result.body);
        } catch (e) {
          data = {};
        }

        if (saveTokens(data)) {
          location.href = "home.html";
          return;
        }

        // 토큰 없이 성공한 경우 — 응답 형식이 바뀐 것이므로 그대로 알린다.
        show("응답에 토큰이 없습니다. 백엔드 응답을 확인해 주세요.", true);
        submitButton.disabled = false;
      })
      .catch(function () {
        show("서버에 연결할 수 없습니다.", true);
        submitButton.disabled = false;
      });
  });
}

// ISO 날짜를 사람이 읽는 형태로 바꾼다. 파싱이 안 되면 원본을 그대로 둔다.
function formatDate(value) {
  var date = new Date(value);
  if (!value || isNaN(date.getTime())) {
    return value || "";
  }
  return (
    date.getFullYear() +
    "년 " +
    (date.getMonth() + 1) +
    "월 " +
    date.getDate() +
    "일"
  );
}

// 로그인 후 화면을 API에 연결한다.
// home.html이 greeting/profile/message/logout 요소를 선언하고 이 함수를 호출한다.
function setupHome() {
  var greeting = document.getElementById("greeting");
  var profile = document.getElementById("profile");
  var message = document.getElementById("message");
  var logout = document.getElementById("logout");

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
  }

  function toLogin() {
    clearTokens();
    location.replace("login.html");
  }

  logout.addEventListener("click", toLogin);

  // 토큰이 아예 없으면 물어볼 것도 없이 로그인 페이지로 보낸다.
  if (!localStorage.getItem("accessToken") && !localStorage.getItem("refreshToken")) {
    location.replace("login.html");
    return;
  }

  // 표를 한 줄씩 채운다. 값이 없는 칸은 빈 칸으로 둔다.
  function addRow(table, label, value) {
    var row = table.insertRow();
    var head = document.createElement("th");
    head.textContent = label;
    row.appendChild(head);
    row.insertCell().textContent = value == null ? "" : String(value);
  }

  function showProfile(me) {
    greeting.textContent = me.email
      ? me.email + " 님으로 로그인되었습니다."
      : "로그인되었습니다.";

    var table = document.createElement("table");
    addRow(table, "회원 번호", me.id);
    addRow(table, "이메일", me.email);
    addRow(table, "이름", me.name || "등록하지 않음");
    addRow(table, "가입일", formatDate(me.createdAt));
    addRow(table, "이메일 인증", me.isEmailVerified ? "완료" : "미완료");
    addRow(
      table,
      "재개봉 알림",
      me.receiveReopenBoxOfficeNotifications ? "받는 중" : "받지 않음"
    );

    // 관리자가 아닌 사람에게는 의미 없는 줄이므로 참일 때만 보여준다.
    if (me.isAdmin) {
      addRow(table, "관리자", "예");
    }

    profile.textContent = "";
    profile.appendChild(table);
  }

  // 응답을 기다리는 동안 화면이 비지 않도록 토큰 안의 이메일을 먼저 띄운다.
  // 표시용일 뿐이고, 확정된 정보는 /users/me 응답으로 덮어쓴다.
  var stored = localStorage.getItem("accessToken");
  var email = stored ? readEmail(stored) : "";
  greeting.textContent = email
    ? email + " 님으로 로그인되었습니다."
    : "로그인되었습니다.";
  profile.textContent = "불러오는 중...";

  authorizedFetch("/users/me")
    .then(function (response) {
      return response.text().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    })
    .then(function (result) {
      if (result.status === 401) {
        // 재발급까지 하고도 거절당했다면 세션이 끝난 것이다.
        toLogin();
        return;
      }

      if (!result.ok) {
        profile.textContent = "";
        show(messageFrom(result.body, result.status), true);
        return;
      }

      var me = {};
      try {
        me = JSON.parse(result.body);
      } catch (e) {
        me = {};
      }
      showProfile(me);
    })
    .catch(function () {
      // 재발급이 거절되면 토큰이 이미 지워져 있다. 그때는 로그인부터 다시 한다.
      if (!localStorage.getItem("accessToken")) {
        location.replace("login.html");
        return;
      }
      profile.textContent = "";
      show("서버에 연결할 수 없습니다.", true);
    });
}

// URL에서 이메일 인증 코드를 꺼낸다.
// 실주소는 /email/verification/482913 형태이고, 로컬 정적 서버에는 rewrite가
// 없으므로 verification.html?code=482913도 함께 받는다.
function readVerificationCode() {
  var matched = location.search.match(/[?&]code=([^&]*)/);
  if (matched) {
    return decodeURIComponent(matched[1]);
  }

  var segments = location.pathname.split("/");
  var last = segments[segments.length - 1];

  // 마지막 조각이 비어 있거나 파일 이름이면 코드가 없는 주소다.
  if (!last || last.indexOf(".") !== -1) {
    return "";
  }
  return decodeURIComponent(last);
}

// 이메일 인증 페이지를 API에 연결한다.
// verification.html이 message 요소를 선언하고 이 함수를 호출한다.
function setupEmailVerification() {
  var message = document.getElementById("message");

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
  }

  var code = readVerificationCode();

  if (!code) {
    show("인증 코드가 없는 주소입니다. 메일의 링크를 다시 확인해 주세요.", true);
    return;
  }

  show("인증 중...", false);

  fetch(API_BASE + "/users/verify/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code })
  })
    .then(function (response) {
      return response.text().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    })
    .then(function (result) {
      if (!result.ok) {
        show(messageFrom(result.body, result.status), true);
        return;
      }

      var data = {};
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        data = {};
      }

      if (data.success) {
        show("이메일 인증이 완료되었습니다.", false);
        return;
      }

      // 200인데 success가 아닌 경우 — 응답 형식이 바뀐 것이므로 그대로 알린다.
      show(messageFrom(result.body, result.status), true);
    })
    .catch(function () {
      show("서버에 연결할 수 없습니다.", true);
    });
}
