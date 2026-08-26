// 백엔드 API 주소.
// 로컬에서 연 페이지는 같은 기계에서 띄운 백엔드를 본다. 그 밖에는 배포된 쪽이다.
var LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
var API_BASE =
  LOCAL_HOSTS.indexOf(location.hostname) === -1
    ? "https://donggyu-sworld-production.up.railway.app"
    : "http://localhost:3000";

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

// 지금 세션의 이메일. 인증 API들이 토큰과 별개로 본문에도 주소를 요구해서 쓴다.
// accessToken이 만료됐어도 그 안의 주소는 여전히 이 사람의 주소이므로 그대로 읽고,
// 없으면 refreshToken을 본다. 표시용이 아니라 요청에 실려 가는 값이지만, 주소를
// 정하는 것은 어차피 서버가 토큰으로 확인하는 신원이다.
function sessionEmail() {
  return (
    readEmail(localStorage.getItem("accessToken") || "") ||
    readEmail(localStorage.getItem("refreshToken") || "")
  );
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

// 로그인 뒤 돌아갈 주소를 URL에서 꺼낸다.
// 다른 사이트로 튕겨 보내는 열린 리다이렉트가 되지 않게 같은 사이트의 경로만 받는다.
// "//evil.com" 과 "/\\evil.com" 은 브라우저가 다른 호스트로 읽으므로 함께 막는다.
function readNextPath() {
  var matched = location.search.match(/[?&]next=([^&]*)/);
  if (!matched) {
    return "";
  }

  var next = decodeURIComponent(matched[1]);
  if (
    next.charAt(0) !== "/" ||
    next.charAt(1) === "/" ||
    next.charAt(1) === "\\"
  ) {
    return "";
  }
  return next;
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
          // 인증 링크처럼 로그인이 막아선 자리가 있으면 그리로 돌려보낸다.
          location.href = readNextPath() || "home.html";
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

// "인증 메일 보내기" 버튼을 만든다. 홈과 인증 실패 화면이 같이 쓴다.
// show(text, isError)로 결과를 알리고, 세션이 끝났으면 onDead()를 부른다.
// 보낸 뒤에 할 일이 화면마다 달라서 성공 문구는 받아 쓴다.
function verificationEmailButton(show, onDead, successText) {
  var button = document.createElement("button");
  button.type = "button";
  button.textContent = "인증 메일 보내기";

  button.addEventListener("click", function () {
    button.disabled = true;
    show("인증 메일을 보내는 중...", false);

    authorizedFetch("/users/email/verification", { method: "POST" })
      .then(function (response) {
        return response.text().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (result.status === 401) {
          onDead();
          return;
        }

        if (!result.ok) {
          // 보내지 못했으니 다시 누를 수 있어야 한다.
          button.disabled = false;
          show(messageFrom(result.body, result.status), true);
          return;
        }

        // 보낸 뒤에는 잠근 채로 둔다. 같은 메일을 연달아 보내 봐야 할 일이
        // 늘지 않고, 다음 차례는 이 화면이 아니라 메일함에 있다.
        show(successText, false);
      })
      .catch(function () {
        // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
        if (!localStorage.getItem("accessToken")) {
          onDead();
          return;
        }
        show("서버에 연결할 수 없습니다.", true);
        button.disabled = false;
      });
  });

  return button;
}

// 재개봉 알림을 켠다. 홈이 표를 그리다가 "이메일 인증은 끝났는데 알림은 꺼져
// 있는" 사람을 만나면 바로 부른다 — 물어보지 않는다. 알림을 받으러 가입한
// 사람에게 "받으시겠습니까"는 한 번 더 누르게 만드는 절차일 뿐이다.
// 값 칸을 통째로 맡아 끝날 때까지 그 자리에서 진행 상태를 보여준다.
// show(text, isError)로 실패를 알리고, 세션이 끝났으면 onDead()를 부른다.
function enableReopenNotifications(cell, show, onDead) {
  var PATH = "/users/receive-reopen-box-office-notifications";

  // 서버가 아무리 빨리 답해도 이만큼은 진행 표시를 띄운 채로 둔다.
  // 누른 적도 없는 값이 소리 없이 바뀌면 무슨 일이 있었는지 알 수 없다.
  var MIN_PENDING_MS = 2500;

  function element(name, className, text) {
    var node = document.createElement(name);
    if (className) {
      node.className = className;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  // 체크 표시는 선을 그리며 나타난다. 이 화면에서 유일하게 움직이는 자리다.
  function checkMark() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "check");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");

    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M3.5 8.5 L6.8 11.8 L12.5 4.8");
    svg.appendChild(path);
    return svg;
  }

  function showDone() {
    cell.textContent = "";
    cell.appendChild(checkMark());
    cell.appendChild(element("span", "settled", "받는 중"));
  }

  // 켜지 못했으면 표는 사실대로 꺼진 상태를 보여준다.
  // 다시 시도할 길은 새로고침이다 — 이 화면에는 누를 것을 두지 않는다.
  function showOff() {
    cell.textContent = "받지 않음";
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  cell.textContent = "";
  cell.appendChild(element("span", "progress"));
  cell.appendChild(element("span", "pending", "켜는 중"));

  // 요청이 거절되어도 Promise.all이 먼저 깨지지 않도록 결과를 값으로 눕힌다.
  // 그래야 성공이든 실패든 최소 대기 시간이 똑같이 지켜진다.
  var settled = authorizedFetch(PATH, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: true })
  })
    .then(function (response) {
      return response.text().then(function (body) {
        return {
          result: { ok: response.ok, status: response.status, body: body }
        };
      });
    })
    .catch(function (error) {
      return { failed: error };
    });

  Promise.all([settled, wait(MIN_PENDING_MS)]).then(function (values) {
    var outcome = values[0];

    if (outcome.failed) {
      // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
      if (!localStorage.getItem("accessToken")) {
        onDead();
        return;
      }
      showOff();
      show("재개봉 알림을 켜지 못했습니다. 서버에 연결할 수 없습니다.", true);
      return;
    }

    var result = outcome.result;

    if (result.status === 401) {
      onDead();
      return;
    }

    if (!result.ok) {
      showOff();
      show(messageFrom(result.body, result.status), true);
      return;
    }

    showDone();
    show("재개봉 알림을 켰습니다.", false);
  });
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

  // 본문까지 읽어야 실패 문구를 꺼낼 수 있으므로 한 덩어리로 눕힌다.
  function read(response) {
    return response.text().then(function (body) {
      return { ok: response.ok, status: response.status, body: body };
    });
  }

  // 재발급까지 하고도 거절당하면 세션이 끝난 것이고, fetch 자체가 거절되면
  // 토큰이 이미 지워졌는지로 재발급 실패와 연결 실패를 가른다.
  function handleFailure(retry) {
    return function () {
      if (!localStorage.getItem("accessToken")) {
        location.replace("login.html");
        return;
      }
      show("서버에 연결할 수 없습니다.", true);
      if (retry) {
        retry.disabled = false;
      }
    };
  }

  logout.addEventListener("click", toLogin);

  // 토큰이 아예 없으면 물어볼 것도 없이 로그인 페이지로 보낸다.
  if (!localStorage.getItem("accessToken") && !localStorage.getItem("refreshToken")) {
    location.replace("login.html");
    return;
  }

  // 표를 한 줄씩 채우고 값 칸을 돌려준다. 값이 없는 칸은 빈 칸으로 둔다.
  function addRow(table, label, value) {
    var row = table.insertRow();
    var head = document.createElement("th");
    head.textContent = label;
    row.appendChild(head);
    var cell = row.insertCell();
    cell.textContent = value == null ? "" : String(value);
    return cell;
  }

  function showProfile(me) {
    greeting.textContent = me.email
      ? me.email + " 님으로 로그인되었습니다."
      : "로그인되었습니다.";

    // 표에는 이 사람이 손댈 수 있는 상태만 남긴다. 이메일은 위 인사말에 이미
    // 있고, 회원 번호나 가입일은 보고 나서 할 일이 없는 값이라 뺐다.
    var table = document.createElement("table");
    var verifyCell = addRow(
      table,
      "이메일 인증",
      me.isEmailVerified ? "완료" : "미완료"
    );
    if (!me.isEmailVerified) {
      // 인증은 메일의 링크에서 끝나므로 이 화면은 결과를 알 수 없다.
      // 다시 열어야 상태가 갱신된다는 것까지 알려 준다.
      verifyCell.appendChild(
        verificationEmailButton(
          show,
          toLogin,
          (me.email ? me.email + " 로 " : "") +
            "인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 이 화면을 새로고침해 주세요."
        )
      );
    }
    var notifyCell = addRow(
      table,
      "재개봉 알림",
      me.receiveReopenBoxOfficeNotifications ? "받는 중" : "받지 않음"
    );
    // 인증을 마쳤는데 알림이 꺼져 있으면 그 자리에서 켠다. 인증 전이라면
    // 켜 봐야 보낼 곳이 없으니, 그 사람의 다음 할 일은 위 줄에 있다.
    if (me.isEmailVerified && !me.receiveReopenBoxOfficeNotifications) {
      enableReopenNotifications(notifyCell, show, toLogin);
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
    .then(read)
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
    .catch(function (error) {
      profile.textContent = "";
      handleFailure(null)(error);
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
  var last = segments.pop();

  // 주소 끝에 슬래시가 붙어도 코드를 찾도록 한 칸 더 본다.
  if (last === "") {
    last = segments.pop() || "";
  }

  // 조각이 비어 있거나 파일 이름이면 코드가 없는 주소다.
  if (!last || last.indexOf(".") !== -1) {
    return "";
  }
  return decodeURIComponent(last);
}

// 이메일 인증 페이지를 API에 연결한다.
// verification.html이 message/detail/actions 요소를 선언하고 이 함수를 호출한다.
function setupEmailVerification() {
  var message = document.getElementById("message");
  var detail = document.getElementById("detail");
  var actions = document.getElementById("actions");

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
  }

  // 서버 원문은 "Unauthorized" 처럼 사람에게 쓸모없을 때가 있다.
  // 그래서 우리 문장을 앞세우고 원문은 아래 작은 줄로 내린다. 형식이 바뀌거나
  // 원인이 다를 때 화면만 보고도 알 수 있어야 해서 버리지는 않는다.
  function showDetail(result) {
    detail.textContent = "서버 응답: " + messageFrom(result.body, result.status);
  }

  // 이 화면은 어느 갈래로 끝나든 다음으로 갈 곳을 준다.
  // 인증에는 로그인이 필요하므로, 로그인한 사람에게 로그인 링크를 주는 것은
  // 할 일이 없는 안내다. 세션이 있으면 홈으로, 없으면 로그인으로 보낸다.
  // 로그인하고 나면 이 주소로 돌아와 인증을 이어서 한다.
  function addOnwardLink() {
    var paragraph = document.createElement("p");
    var link = document.createElement("a");

    if (hasSession()) {
      link.href = "/home.html";
      link.textContent = "홈으로";
    } else {
      link.href =
        "/login.html?next=" +
        encodeURIComponent(location.pathname + location.search);
      link.textContent = "로그인";
    }

    paragraph.appendChild(link);
    actions.appendChild(paragraph);
  }

  function addLine(text) {
    var paragraph = document.createElement("p");
    paragraph.textContent = text;
    actions.appendChild(paragraph);
  }

  function read(response) {
    return response.text().then(function (body) {
      return { ok: response.ok, status: response.status, body: body };
    });
  }

  function hasSession() {
    return !!(
      localStorage.getItem("accessToken") || localStorage.getItem("refreshToken")
    );
  }

  // 인증에 실패했으면 이 코드는 다시 쓸 수 없다. 로그인 링크만 남기는 대신
  // 새 메일을 받을 길을 준다. 재발송에는 토큰이 필요하므로 로그인한 사람에게만
  // 버튼이고, 아닌 사람은 로그인부터 해야 한다.
  function offerAnotherEmail() {
    actions.textContent = "";

    if (!hasSession()) {
      addLine("로그인하면 인증 메일을 다시 받을 수 있습니다.");
      addOnwardLink();
      return;
    }

    addLine("아래 버튼을 누르면 인증 메일을 다시 보냅니다.");

    var paragraph = document.createElement("p");
    paragraph.appendChild(
      verificationEmailButton(
        show,
        function () {
          // 재발송조차 거절당했다 — 이 화면에서 더 할 수 있는 일이 없다.
          clearTokens();
          detail.textContent = "";
          actions.textContent = "";
          show("세션이 만료되었습니다. 다시 로그인해 주세요.", true);
          addOnwardLink();
        },
        "인증 메일을 다시 보냈습니다. 메일의 새 링크를 눌러 주세요."
      )
    );
    actions.appendChild(paragraph);

    // 메일을 기다리지 않고 나갈 수도 있어야 한다.
    addOnwardLink();
  }

  var code = readVerificationCode();

  if (!code) {
    show("인증 코드가 없는 주소입니다. 메일의 링크를 다시 확인해 주세요.", true);
    addOnwardLink();
    return;
  }

  // 이 API 는 가드가 걸려 있어 로그인한 사람만 부를 수 있다. 토큰이 없으면
  // 보내 봐야 코드에 닿기도 전에 막히므로, 요청 대신 로그인부터 하게 한다.
  if (!hasSession()) {
    show("이 링크로 인증하려면 먼저 로그인해야 합니다.", true);
    addLine("로그인하면 이 화면으로 돌아와 인증을 이어서 합니다.");
    addOnwardLink();
    return;
  }

  show("인증 중...", false);

  // 토큰을 붙여 보내는데도 본문에 이메일을 또 요구한다. 빠뜨리면 코드에 닿기도
  // 전에 400 "email must be a string" 으로 막힌다.
  authorizedFetch("/users/verify/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: sessionEmail(), code: code })
  })
    .then(read)
    .then(function (result) {
      var data = {};
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        data = {};
      }

      if (result.ok && data.success) {
        show("이메일 인증이 완료되었습니다.", false);
        addOnwardLink();
        return;
      }

      // 실패 응답도, 200인데 success가 아닌 경우도 이 코드는 못 쓴다는 뜻이다.
      show(
        "이메일 인증에 실패했습니다. 링크가 만료되었거나 이미 사용한 코드일 수 있습니다.",
        true
      );
      showDetail(result);
      offerAnotherEmail();
    })
    .catch(function () {
      // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
      if (!localStorage.getItem("accessToken")) {
        show("세션이 만료되었습니다. 다시 로그인한 뒤 링크를 열어 주세요.", true);
        addOnwardLink();
        return;
      }

      // 코드가 아직 살아 있을 수도 있으므로 재발송은 권하지 않는다.
      // 그래도 이 화면에 가둬 두지는 않는다.
      show("서버에 연결할 수 없습니다. 잠시 뒤 링크를 다시 열어 주세요.", true);
      addOnwardLink();
    });
}

// 비밀번호 재설정 화면을 API에 연결한다.
// password.html이 email/code/password 세 폼과 message/detail 요소를 선언하고
// 이 함수를 호출한다.
//
// 세 단계를 한 화면에 둔 이유는 마지막 PATCH가 이메일을 다시 요구하기 때문이다.
// 메일의 링크에서 끝나는 이메일 인증과 달리 여기서는 주소를 끝까지 손에 쥐고
// 있어야 해서, 코드를 받은 그 자리에서 이어 간다.
//
// 비밀번호를 잊은 사람은 로그인할 수 없다. 그래서 세 단계 모두 토큰 없이 부르고,
// authorizedFetch가 아니라 맨 fetch를 쓴다. 이 화면에 authorizedFetch가 끼어드는
// 순간 "이미 로그인한 사람만 쓸 수 있는 비밀번호 찾기"가 되므로, 어느 단계가
// 401을 주더라도 고칠 곳은 이 파일이 아니라 그 엔드포인트의 가드다.
function setupPasswordReset() {
  var MIN_PASSWORD = 8;

  var emailForm = document.getElementById("email-form");
  var emailInput = document.getElementById("email");
  var sendButton = document.getElementById("send");

  var codeForm = document.getElementById("code-form");
  var codeInput = document.getElementById("code");
  var verifyButton = document.getElementById("verify");

  var passwordForm = document.getElementById("password-form");
  var passwordInput = document.getElementById("password");
  var resetButton = document.getElementById("reset");

  var message = document.getElementById("message");
  var detail = document.getElementById("detail");

  // 코드를 보낸 주소. 마지막 요청은 입력칸이 아니라 이 값을 쓴다.
  // 칸은 잠가 두므로 지금은 같은 값이지만, 바꾸는 것은 주소가 아니라
  // "코드가 도착한 그 주소"의 비밀번호여야 한다.
  var sentEmail = "";

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
    detail.textContent = "";
  }

  // 서버 원문은 작은 줄로 남긴다. 응답 형식이 바뀌거나 원인이 다를 때
  // 화면만 보고도 알 수 있어야 한다. show() 뒤에 불러야 지워지지 않는다.
  function showDetail(result) {
    detail.textContent = "서버 응답: " + messageFrom(result.body, result.status);
  }

  // 서버가 주는 문구를 그대로 앞세우되 5xx는 예외로 둔다. 그쪽 본문은
  // "Internal server error" 라서, 사용자가 무엇을 잘못했는지도 다음에 무엇을
  // 해야 하는지도 알려 주지 않는다. 그때만 우리 문장을 세우고 원문을 내린다.
  function showFailure(result) {
    if (result.status >= 500) {
      show("요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.", true);
      showDetail(result);
      return;
    }
    show(messageFrom(result.body, result.status), true);
  }

  function read(response) {
    return response.text().then(function (body) {
      return { ok: response.ok, status: response.status, body: body };
    });
  }

  // 끝난 단계는 지우지 않고 잠근다. 어느 주소로 보냈는지가 코드를 옮겨 적는
  // 동안에도 보여야 하고, 지나온 칸이 남아 있어야 어디까지 왔는지 알 수 있다.
  function lock(input, button) {
    input.disabled = true;
    button.disabled = true;
  }

  function reveal(form, input) {
    form.hidden = false;
    input.focus();
  }

  // 1단계 — 코드를 메일로 받는다.
  emailForm.addEventListener("submit", function (event) {
    event.preventDefault();

    var email = emailInput.value.trim();
    if (!email || email.indexOf("@") === -1) {
      show("이메일 주소를 확인해 주세요.", true);
      emailInput.focus();
      return;
    }

    sendButton.disabled = true;
    show("인증 코드를 보내는 중...", false);

    fetch(API_BASE + "/users/password/verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email })
    })
      .then(read)
      .then(function (result) {
        if (!result.ok) {
          sendButton.disabled = false;
          showFailure(result);
          return;
        }

        // 서버는 이 응답에 code까지 실어 보낸다. 읽지 않는다 — 그 값을 쓰면
        // 메일함을 거치지 않고 비밀번호를 바꿀 수 있게 되고, 그건 이 절차가
        // 막으라고 있는 바로 그 일이다. 코드는 사람이 메일에서 옮겨 적는다.
        sentEmail = email;
        lock(emailInput, sendButton);
        reveal(codeForm, codeInput);

        // 없는 계정에도 서버는 똑같이 201을 준다. 그래서 이 화면은 주소가
        // 맞는지 알 수 없고, 알 수 없다는 사실을 그대로 적는다.
        show(
          email +
            " 로 인증 코드를 보냈습니다. 메일이 오지 않으면 주소를 확인하고 새로고침해 주세요.",
          false
        );
      })
      .catch(function () {
        sendButton.disabled = false;
        show("서버에 연결할 수 없습니다.", true);
      });
  });

  // 2단계 — 받은 코드를 확인받는다.
  codeForm.addEventListener("submit", function (event) {
    event.preventDefault();

    var code = codeInput.value.trim();
    if (!code) {
      show("메일로 받은 인증 코드를 입력해 주세요.", true);
      codeInput.focus();
      return;
    }

    verifyButton.disabled = true;
    show("인증 중...", false);

    fetch(API_BASE + "/users/verify/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: sentEmail, code: code })
    })
      .then(read)
      .then(function (result) {
        var data = {};
        try {
          data = JSON.parse(result.body);
        } catch (e) {
          data = {};
        }

        if (result.ok && data.success) {
          lock(codeInput, verifyButton);
          reveal(passwordForm, passwordInput);
          show("인증되었습니다. 새 비밀번호를 정해 주세요.", false);
          return;
        }

        verifyButton.disabled = false;
        codeInput.focus();
        codeInput.select();

        // 틀린 코드는 실패 응답이 아니라 201 { success: false } 로 돌아온다.
        // 성공과 같은 상태 코드에 문구가 한 줄도 실려 있지 않으므로, 이 경우의
        // 문장은 서버에서 꺼내 올 수가 없고 우리가 쓴다.
        if (result.ok) {
          show("인증 코드가 맞지 않습니다. 메일에 적힌 숫자를 다시 확인해 주세요.", true);
          return;
        }

        // 나머지 실패에는 서버가 한국어 문구를 실어 보낸다 — "이미 인증된
        // 코드입니다." 처럼 우리가 지어낼 수 있는 것보다 정확하므로 그대로 쓴다.
        // 5xx 만 showFailure 가 갈라내 우리 문장으로 바꾸고 원문을 아래로 내린다.
        showFailure(result);
      })
      .catch(function () {
        verifyButton.disabled = false;
        show("서버에 연결할 수 없습니다.", true);
      });
  });

  // 3단계 — 새 비밀번호를 건다.
  passwordForm.addEventListener("submit", function (event) {
    event.preventDefault();

    var password = passwordInput.value;
    if (password.length < MIN_PASSWORD) {
      show("비밀번호는 " + MIN_PASSWORD + "자 이상이어야 합니다.", true);
      passwordInput.focus();
      return;
    }

    resetButton.disabled = true;
    show("비밀번호를 바꾸는 중...", false);

    fetch(API_BASE + "/users/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: sentEmail, password: password })
    })
      .then(read)
      .then(function (result) {
        if (!result.ok) {
          resetButton.disabled = false;
          showFailure(result);
          return;
        }

        // 이 API는 토큰을 주지 않으므로 여기서 로그인시킬 방법이 없고,
        // 바뀐 비밀번호를 쓸 자리는 로그인 화면이다. 아래 링크가 그 자리다.
        lock(passwordInput, resetButton);
        show("비밀번호를 바꿨습니다. 새 비밀번호로 로그인해 주세요.", false);
      })
      .catch(function () {
        resetButton.disabled = false;
        show("서버에 연결할 수 없습니다.", true);
      });
  });
}
