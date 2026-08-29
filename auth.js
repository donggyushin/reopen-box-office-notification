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

// 로그인한 사람인지. accessToken 이 만료됐어도 refreshToken 으로 되살릴 수 있으므로
// 둘 중 하나라도 있으면 세션이 있는 것으로 본다. 홈이 로그인으로 되돌리는 기준과
// 로그인/회원가입이 홈으로 보내는 기준이 같은 함수라야 두 화면이 서로를 튕기지 않는다.
function hasSession() {
  return !!(
    localStorage.getItem("accessToken") || localStorage.getItem("refreshToken")
  );
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
  // 이미 로그인한 사람에게 이 폼은 물어볼 것이 없다. 홈이 토큰이 하나도 없을 때
  // 로그인으로 되돌리는 것과 정확히 반대 방향이고, 기준이 같아서 둘이 맞물리지 않는다.
  // 죽은 토큰이면 홈이 재발급에 실패해 토큰을 지우고 되돌려 보내므로 한 번만 더 돈다.
  if (hasSession()) {
    location.replace(readNextPath() || "home.html");
    return;
  }

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

// ISO 날짜를 YYYY-MM-DD 로 줄인다. 회원 목록의 가입일과 보낸 알림의 발송일이 같은
// 규칙을 쓴다 — 둘 다 응답에는 시각까지 실려 오는데, 그대로 적으면 칸만 넓어지고
// 읽을 것은 늘지 않는다. 두 화면이 날짜를 다르게 적으면 같은 값을 두 번 배우게
// 되므로 한 벌만 둔다.
//
// 읽을 수 없는 값은 손대지 않고 그대로 적는다. 응답 형식이 바뀐 것을 화면만 보고도
// 알아볼 수 있어야 한다.
function dayText(value) {
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  if (!value) {
    return "";
  }

  var date = new Date(value);
  if (isNaN(date.getTime())) {
    return String(value);
  }
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate())
  );
}

// 켜진 상태를 나타내는 체크 표시. 표의 값 칸에서 "완료", "받는 중" 같은 말을
// 대신한다 — 줄 이름이 이미 무엇에 대한 답인지 말하고 있어서 값 칸에는 예/아니오만
// 있으면 되고, 글자보다 표시가 한눈에 들어온다. 그림만 남으므로 읽어 주는 도구에는
// 원래의 말이 들리도록 label 을 붙인다.
//
// animated 는 방금 그렇게 된 자리에서만 준다. 새로고침으로 이미 켜져 있던 값이
// 선을 그리며 나타나면, 지금 막 일어난 일처럼 보여서 거짓말이 된다.
function checkMark(label, animated) {
  var ns = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", animated ? "check drawn" : "check");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);

  var path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3.5 8.5 L6.8 11.8 L12.5 4.8");
  svg.appendChild(path);
  return svg;
}

// 알림 한 줄의 값 칸을 맡는다. 지금 상태를 적고, 그 상태를 뒤집는 버튼을 그 옆에
// 둔다 — 위의 이메일 인증 줄이 이미 "상태 + 할 일" 모양이라, 알림 줄도 같은 모양이면
// 표 전체가 한 가지 말투로 읽힌다. 값 칸을 통째로 갈아 끼우지 않고 상태 자리와 버튼을
// 따로 들고 있는 이유는 하나다 — 버튼을 다시 만들면 방금 그것을 누른 손가락은
// 괜찮아도 키보드는 초점을 잃는다.
//
// 조건은 켜는 쪽에만 있다. 인증하지 않은 주소로 알림을 켜면 보낼 곳이 없으므로
// 처음부터 꺼져 있는 줄에는 버튼을 그리지 않는다 — 그 사람의 다음 할 일은 위 줄에
// 있다. 하지만 이미 켜져 있던 줄에는 인증 여부와 상관없이 버튼이 선다. 끄는 일이
// 위험한 적은 없고, 한 번 끄면 되돌릴 수 없는 스위치는 스위치가 아니다.
//
// options: { name, path, on, canTurnOn, detail, show, onDead }
function notificationSwitch(cell, options) {
  var name = options.name;
  var on = !!options.on;
  var show = options.show;

  var state = document.createElement("span");
  cell.textContent = "";
  cell.appendChild(state);

  var control = null;
  if (on || options.canTurnOn) {
    control = document.createElement("button");
    control.type = "button";
    control.addEventListener("click", flip);
    cell.appendChild(control);
  }

  // animated 는 방금 눌러서 켜진 자리에만 준다. 새로고침으로 이미 켜져 있던 값이
  // 선을 그리며 나타나면 지금 막 그렇게 된 것처럼 보여서 거짓말이 된다.
  function draw(animated) {
    state.textContent = "";
    if (on) {
      state.appendChild(checkMark("받는 중", animated));
    } else {
      state.textContent = "받지 않음";
    }

    if (control) {
      control.textContent = on ? "끄기" : "받기";
      control.disabled = false;
    }
  }

  function flip() {
    var next = !on;

    control.disabled = true;
    show(name + "을 " + (next ? "켜는" : "끄는") + " 중...", false);

    authorizedFetch(options.path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: next })
    })
      .then(function (response) {
        return response.text().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (result.status === 401) {
          options.onDead();
          return;
        }

        if (!result.ok) {
          // 바뀐 것이 없으니 값 칸은 그대로 두고 버튼만 되살린다.
          control.disabled = false;
          show(messageFrom(result.body, result.status), true);
          return;
        }

        on = next;
        draw(next);

        var text = name + (next ? "을 켰습니다." : "을 껐습니다.");
        if (next && options.detail) {
          text += " " + options.detail;
        }
        show(text, false);
      })
      .catch(function () {
        // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
        if (!localStorage.getItem("accessToken")) {
          options.onDead();
          return;
        }
        control.disabled = false;
        show("서버에 연결할 수 없습니다.", true);
      });
  }

  draw(false);
}

// 알림 위치. 비 예보는 이 좌표로 날씨를 보고, 좌표가 없으면 서울을 본다 — 그래서
// 값 칸은 비워 두는 대신 "서울 (기본)"이라고 적는다. 정하지 않았다는 말과 그때 실제로
// 무슨 일이 일어나는지는 같은 자리에 있어야 한다.
//
// 좌표를 손으로 적게 하지 않는다. 자기 위도와 경도를 아는 사람은 없고 브라우저는 이미
// 답을 갖고 있으니, 이 줄의 컨트롤은 입력칸이 아니라 버튼이다. 허락을 묻는 창도
// 브라우저가 띄우므로 이 화면에는 "쓰시겠습니까"를 두지 않는다.
//
// 이 줄에는 인증 조건이 없다. 좌표는 주소로 보내는 것이 아니라 어디를 볼지를 정하는
// 값이라, 인증 전에 미리 맞춰 둬도 가리키는 곳이 없어지지 않는다.
function coordinateRow(cell, me, show, onDead) {
  var PATH = "/users/coordinate";

  // 소수점 넷째 자리면 10m 안쪽이다. 날씨를 보는 데 그보다 정밀할 이유가 없고,
  // 보내는 값과 화면에 적는 값을 같은 자리에서 끊어 두면 둘이 어긋나지 않는다.
  var PLACES = 4;

  var latitude = null;
  var longitude = null;

  // 서버가 문자열로 주든 숫자로 주든 같게 받는다. 읽을 수 없는 값은 없는 것으로 친다 —
  // 좌표가 아닌 것을 좌표라고 적는 것보다 서울을 본다고 적는 편이 사실에 가깝다.
  function number(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    var parsed = Number(value);
    return isNaN(parsed) ? null : parsed;
  }

  function has() {
    return latitude !== null && longitude !== null;
  }

  function button(text, onClick) {
    var node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", function () {
      onClick(node);
    });
    return node;
  }

  var state = document.createElement("span");
  var use = button("현재 위치 사용", locate);
  var erase = button("지우기", clear);

  cell.textContent = "";
  cell.appendChild(state);
  cell.appendChild(use);

  function draw() {
    state.textContent = has()
      ? latitude.toFixed(PLACES) + ", " + longitude.toFixed(PLACES)
      : "서울 (기본)";

    use.disabled = false;
    erase.disabled = false;

    // 지울 것이 없으면 지우기도 없다. 이 버튼만은 붙였다 뗐다 하는데, 좌표가 없는
    // 줄에 놓인 지우기는 눌러도 아무 일이 없는 버튼이기 때문이다.
    if (has() && !erase.parentNode) {
      cell.appendChild(erase);
    } else if (!has() && erase.parentNode) {
      cell.removeChild(erase);
    }
  }

  function locate(node) {
    if (!navigator.geolocation) {
      show("이 브라우저는 위치를 알려 주지 않습니다.", true);
      return;
    }

    node.disabled = true;
    show("위치를 확인하는 중...", false);

    navigator.geolocation.getCurrentPosition(
      function (position) {
        send(
          {
            latitude: Number(position.coords.latitude.toFixed(PLACES)),
            longitude: Number(position.coords.longitude.toFixed(PLACES))
          },
          node,
          "알림 위치를 지금 있는 곳으로 맞췄습니다."
        );
      },
      function (error) {
        node.disabled = false;
        // 거부는 이 화면에서 되돌릴 수 없다. 다음 걸음이 브라우저 설정에만 있으니
        // 그것만 적는다. 나머지 실패는 다시 눌러 보는 것 말고 할 일이 없다.
        show(
          error && error.code === 1
            ? "위치 사용이 거부되었습니다. 브라우저 설정에서 이 사이트의 위치 사용을 허용해 주세요."
            : "위치를 확인할 수 없습니다.",
          true
        );
      },
      { timeout: 10000, maximumAge: 0 }
    );
  }

  function clear(node) {
    node.disabled = true;
    show("알림 위치를 지우는 중...", false);
    send(
      { latitude: null, longitude: null },
      node,
      "알림 위치를 지웠습니다. 서울을 기준으로 확인합니다."
    );
  }

  function send(next, node, doneText) {
    authorizedFetch(PATH, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next)
    })
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
          // 바뀐 것이 없으니 값 칸은 그대로 두고 버튼만 되살린다.
          node.disabled = false;
          show(messageFrom(result.body, result.status), true);
          return;
        }

        latitude = next.latitude;
        longitude = next.longitude;
        draw();
        show(doneText, false);
      })
      .catch(function () {
        // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
        if (!localStorage.getItem("accessToken")) {
          onDead();
          return;
        }
        node.disabled = false;
        show("서버에 연결할 수 없습니다.", true);
      });
  }

  latitude = number(me.latitude);
  longitude = number(me.longitude);
  draw();
}

// 일별 박스오피스 순위를 홈에 그린다. chart 는 표가 들어갈 자리이고, highlight 는
// 그중 재개봉작만 한 번 더 적는 맨 위 자리다.
//
// 여기서는 authorizedFetch() 를 쓰지 않는다. 이 순위는 로그인과 상관없는 공개
// 자료라 토큰을 붙일 이유가 없고, 무엇보다 순위를 못 불러온 일이 세션을 끝내면
// 안 되기 때문이다. 그래서 실패도 이 자리에만 적는다 — #message 는 위 표가 쓰는
// 자리이고, 토큰은 어느 갈래에서도 건드리지 않는다.
function loadBoxOffice(chart, highlight) {
  var PATH = "/box-office/daily";

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

  function number(value) {
    var n = Number(value);
    if (value == null || value === "" || !isFinite(n)) {
      return "";
    }
    return n.toLocaleString("ko-KR");
  }

  // 표 대신 한 줄만 남는 경우들. 맨 위 자리는 손대지 않는다 — 순위를 모르는데
  // "재개봉작이 없다"고 적으면 없는 것을 아는 것처럼 보인다.
  function note(text, isError) {
    chart.textContent = "";
    chart.appendChild(element("p", isError ? "error" : null, text));
  }

  // 재개봉작은 열 줄 중 한 줄이라 표 안에서는 찾아야 보인다. 이 서비스가
  // 알려 주겠다고 한 것이 그 한 줄이니 맨 위에 한 번 더 적는다. 없는 날에는
  // 없다고 적는다 — 빈 자리는 오늘 순위를 못 불러온 것과 구별되지 않는다.
  function drawHighlight(reopens) {
    highlight.textContent = "";
    highlight.appendChild(element("h2", null, "재개봉작"));

    if (!reopens.length) {
      highlight.appendChild(
        element("p", null, "오늘 순위에 재개봉 영화는 없습니다.")
      );
      return;
    }

    reopens.forEach(function (movie) {
      var line = element("p", null);
      line.appendChild(element("span", "name", movie.movieNm || "제목 없음"));
      if (movie.rank != null) {
        line.appendChild(document.createTextNode(" " + movie.rank + "위"));
      }

      // 재개봉작에서 개봉일은 그 자체로 읽을 거리다. 오늘 관객수는 표에도
      // 있지만, 여기까지 보고 표로 내려가지 않는 사람이 있다.
      var detail = [];
      if (movie.openDt) {
        detail.push(movie.openDt + " 개봉");
      }
      var audience = number(movie.audiCnt);
      if (audience) {
        detail.push("오늘 관객 " + audience + "명");
      }
      if (detail.length) {
        line.appendChild(element("small", null, detail.join(" · ")));
      }

      highlight.appendChild(line);
    });
  }

  function drawChart(list) {
    // 막대는 1위를 가득 채운 것으로 두고 나머지를 그 비율로 그린다. 관객수는
    // 1위와 10위가 백 배 넘게 벌어지는 값이라 아래쪽 막대는 자국만 남는다.
    // 그래서 숫자를 막대 옆에 그대로 적었다 — 막대는 크기 비교만 맡는다.
    var top = 0;
    list.forEach(function (movie) {
      var n = Number(movie.audiCnt);
      if (isFinite(n) && n > top) {
        top = n;
      }
    });

    var table = element("table", "chart");
    table.appendChild(element("caption", null, "일별 박스오피스 · 관객수"));

    list.forEach(function (movie) {
      var row = table.insertRow();
      if (movie.isReopen) {
        row.className = "reopen";
      }

      var rank = row.insertCell();
      rank.className = "rank";
      rank.textContent = movie.rank == null ? "" : String(movie.rank);

      var cell = row.insertCell();
      var name = element("div", "name", movie.movieNm || "제목 없음");
      // 색만으로는 무슨 표시인지 알 수 없으니 말도 같이 붙인다.
      if (movie.isReopen) {
        name.appendChild(element("span", "tag", "재개봉"));
      }
      cell.appendChild(name);

      var bar = element("div", "bar");
      var value = Number(movie.audiCnt);
      if (isFinite(value) && value > 0 && top > 0) {
        var fill = element("span", null);
        fill.style.width = (value / top) * 100 + "%";
        bar.appendChild(fill);
      }
      cell.appendChild(bar);

      var count = row.insertCell();
      count.className = "count";
      count.textContent = number(movie.audiCnt);
    });

    chart.textContent = "";
    chart.appendChild(table);
  }

  note("박스오피스 순위를 불러오는 중...", false);

  fetch(API_BASE + PATH)
    .then(function (response) {
      return response.text().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    })
    .then(function (result) {
      if (!result.ok) {
        note(messageFrom(result.body, result.status), true);
        return;
      }

      var data = {};
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        data = {};
      }

      var list = Array.isArray(data.boxOfficeList) ? data.boxOfficeList : [];
      if (!list.length) {
        note("오늘 박스오피스 순위가 아직 없습니다.", false);
        return;
      }

      drawChart(list);
      drawHighlight(
        list.filter(function (movie) {
          return movie.isReopen;
        })
      );
    })
    .catch(function () {
      note("박스오피스 순위를 불러오지 못했습니다. 서버에 연결할 수 없습니다.", true);
    });
}

// 로그인 후 화면을 API에 연결한다.
// home.html이 reopen/greeting/profile/message/chart/admin/logout 요소를 선언하고
// 이 함수를 호출한다.
function setupHome() {
  var greeting = document.getElementById("greeting");
  var profile = document.getElementById("profile");
  var message = document.getElementById("message");
  var logout = document.getElementById("logout");
  var chart = document.getElementById("chart");
  var reopen = document.getElementById("reopen");
  var admin = document.getElementById("admin");

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
  if (!hasSession()) {
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
    // 끝난 상태는 체크 표시로, 아직인 상태는 글자로 둔다. 아직인 쪽에는 할 일이
    // 남아 있어서 — 이 줄에는 버튼까지 붙는다 — 말로 적어 주는 편이 맞다.
    var verifyCell = addRow(
      table,
      "이메일 인증",
      me.isEmailVerified ? "" : "미완료"
    );
    if (me.isEmailVerified) {
      verifyCell.appendChild(checkMark("완료", false));
    } else {
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
    // 알림 줄은 둘 다 같은 스위치다. 다른 것은 엔드포인트와 켠 뒤에 덧붙일 말뿐이라,
    // 줄을 만드는 일과 스위치를 다는 일을 한자리에서 한다.
    function addSwitch(label, options) {
      options.name = label;
      options.canTurnOn = me.isEmailVerified;
      options.show = show;
      options.onDead = toLogin;
      notificationSwitch(addRow(table, label), options);
    }

    addSwitch("재개봉 알림", {
      path: "/users/receive-reopen-box-office-notifications",
      on: me.receiveReopenBoxOfficeNotifications
    });

    addSwitch("비 예보 알림", {
      path: "/users/receive-tomorrow-rain",
      on: me.receiveTomorrowRainNotifications,
      detail: "비가 오는 날 하루 전에 메일로 알려 드립니다."
    });

    // 바로 위 줄이 어디를 볼지 정하는 값이라 그 아래에 둔다. 비 예보를 끄고 있는
    // 사람에게도 그린다 — 켜고 끌 때마다 표의 줄 수가 바뀌면, 방금 누른 버튼이
    // 눈앞에서 자리를 옮긴다.
    coordinateRow(addRow(table, "알림 위치"), me, show, toLogin);

    profile.textContent = "";
    profile.appendChild(table);

    // 관리자에게만 회원 목록으로 가는 길을 낸다. isAdmin 은 위 표에 넣지 않는다 —
    // 그건 이 사람이 손댈 수 있는 상태가 아니라 화면 밖에 문이 하나 더 있다는
    // 뜻이라서, 값이 앉을 자리는 표의 줄이 아니라 링크다.
    if (me.isAdmin) {
      var link = document.createElement("a");
      link.href = "users.html";
      link.textContent = "회원 목록";
      admin.appendChild(link);
    }
  }

  // 응답을 기다리는 동안 화면이 비지 않도록 토큰 안의 이메일을 먼저 띄운다.
  // 표시용일 뿐이고, 확정된 정보는 /users/me 응답으로 덮어쓴다.
  var stored = localStorage.getItem("accessToken");
  var email = stored ? readEmail(stored) : "";
  greeting.textContent = email
    ? email + " 님으로 로그인되었습니다."
    : "로그인되었습니다.";
  profile.textContent = "불러오는 중...";

  // 순위는 이 사람이 누구인지와 상관없는 자료라 /users/me 를 기다리지 않는다.
  // 두 요청은 나란히 가고, 한쪽이 늦거나 실패해도 다른 쪽은 그대로 그려진다.
  loadBoxOffice(chart, reopen);

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

// 지금까지 재개봉 알림을 보낸 영화 목록을 그린다.
// sent.html 이 message/sent 요소를 선언하고 이 함수를 호출한다.
//
// 이 화면은 loadBoxOffice() 쪽에 선다. GET /box-office/sent 는 토큰을 보지 않는
// 공개 자료라 맨 fetch 로 부르고, 그래서 세션 가드도 두지 않는다 — 여기 실리는
// 것은 남의 개인정보가 아니라 우리가 무엇을 알렸는지에 대한 기록이고, 데이터를
// 막지 못하는 가드는 지키는 시늉만 한다(README 의 "알아둘 점"). 어느 갈래에서도
// 토큰은 건드리지 않는다 — 기록을 못 그린 일이 세션을 끝내면 안 된다.
function setupSentAlerts() {
  var PATH = "/box-office/sent";

  var message = document.getElementById("message");
  var sent = document.getElementById("sent");

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
  }

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

  function headCell(row, label, className) {
    row.appendChild(element("th", className, label));
  }

  // 최근에 보낸 것부터 세운다 — 이 화면을 여는 이유는 대개 "요즘 뭘 알려 줬나"라서
  // 회원 목록과 같은 쪽을 첫 줄에 둔다. 기준은 첫 칸에 적히는 그 값, createdAt 이다.
  // id 로 세워도 결과는 대개 같겠지만, 그래서 더 id 로 세우면 안 된다 — 적는 값과
  // 줄을 세우는 값이 다르면 둘이 어긋나는 날에야 티가 나고, 그날 화면은 거짓말을
  // 하고 있다.
  //
  // 읽을 수 없는 발송일이 하나라도 있으면 서버가 준 순서를 그대로 둔다. 지어낸
  // 순서보다 모르는 순서가 낫다.
  function orderedBySent(rows) {
    var readable = rows.every(function (movie) {
      return (
        movie &&
        movie.createdAt &&
        !isNaN(new Date(movie.createdAt).getTime())
      );
    });

    if (!readable) {
      return rows;
    }
    return rows.slice().sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  function buildTable(rows) {
    var table = element("table", "sent");

    // 몇 편인지만 적는다. 어느 쪽부터 서 있는지는 쓰지 않는다 — 발송일이 첫 칸에
    // 그대로 있어서 줄 순서는 보면 안다. 눈에 보이는 것을 글로 한 번 더 말할
    // 이유가 없다.
    table.appendChild(element("caption", null, "전체 " + rows.length + "편"));

    // 줄은 thead/tbody 에 직접 넣는다. table.insertRow() 는 이미 있는 마지막 tr 의
    // 부모에 붙는 규칙이라, 머리줄을 먼저 만들면 본문 줄까지 thead 안으로 들어간다.
    var head = table.createTHead().insertRow();
    headCell(head, "발송일", "day");
    headCell(head, "제목", "name");
    headCell(head, "개봉일", "day");

    var body = table.createTBody();
    rows.forEach(function (movie) {
      var row = body.insertRow();

      // 이 목록이 이 순서로 서 있는 이유가 이 칸이라 맨 앞에 둔다. 줄 순서를
      // 표 위에서 말로 주장하는 대신 값으로 보이게 하는 자리다.
      var sentDay = row.insertCell();
      sentDay.className = "day";
      sentDay.textContent = dayText(movie.createdAt);

      // 제목에 "재개봉" 표는 붙이지 않는다. 홈의 표에서 그 표는 열 줄 중 한 줄을
      // 가리키는 말이었는데, 이 목록은 모든 줄이 재개봉작이라 전부에 붙이면
      // 아무것도 가리키지 못한다.
      var name = row.insertCell();
      name.className = "name";
      name.textContent = movie.movieNm || "제목 없음";

      // 재개봉작의 개봉일은 처음 걸렸던 날이다. 두 날짜를 붙여 놓으면 서로
      // 헷갈리므로 제목을 사이에 두고 반대쪽 끝에 앉힌다.
      var day = row.insertCell();
      day.className = "day";
      day.textContent = movie.openDt || "";
    });

    return table;
  }

  // 한 편도 없는 것은 고장이 아니라 아직 보낼 일이 없었다는 뜻이다. 배포된
  // 백엔드가 지금 그 상태라 이 화면이 첫인상이 되는데, 빈 자리만 남으면 못
  // 불러온 것과 구별되지 않는다. 그래서 언제 채워지는지까지 적는다.
  function drawEmpty() {
    sent.textContent = "";
    sent.appendChild(element("p", null, "아직 보낸 재개봉 알림이 없습니다."));
    sent.appendChild(
      element(
        "p",
        null,
        "재개봉 영화가 일별 박스오피스 순위에 오르면 알림을 보내고, 그 기록이 여기 쌓입니다."
      )
    );
  }

  show("보낸 알림을 불러오는 중...", false);

  fetch(API_BASE + PATH)
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

      var data = null;
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        data = null;
      }

      // 200 인데 목록이 없는 것은 한 편도 없다는 뜻이 아니라 답을 못 읽었다는
      // 뜻이다. 이 화면에서 빈 목록은 흔한 상태라 — 지금 배포된 백엔드가 그렇다 —
      // 둘을 같은 말로 적으면 고장이 평상시처럼 보인다. loadBoxOffice() 는 여기서
      // 갈래를 나누지 않는데, 그쪽의 빈 목록은 하루에 한 번쯤 있는 일이고 이쪽은
      // 첫 화면이라 값이 다르다.
      var rows =
        data && Array.isArray(data.sentBoxOfficeList)
          ? data.sentBoxOfficeList
          : null;

      if (!rows) {
        show("보낸 알림을 읽지 못했습니다. 응답 형식이 바뀌었을 수 있습니다.", true);
        return;
      }

      show("", false);

      if (!rows.length) {
        drawEmpty();
        return;
      }

      sent.textContent = "";
      sent.appendChild(buildTable(orderedBySent(rows)));
    })
    .catch(function () {
      show("보낸 알림을 불러오지 못했습니다. 서버에 연결할 수 없습니다.", true);
    });
}

// 회원 목록 화면을 API에 연결한다.
// users.html이 message/users/pager 요소를 선언하고 이 함수를 호출한다.
//
// 이 화면은 관리자만 본다. 문을 지키는 것은 /users/me 의 isAdmin 하나이고, 그
// 답이 오기 전에는 목록을 부르지도 않는다 — /users/me 와 박스오피스를 나란히
// 보내는 홈과 반대로 여기서는 순서가 곧 가드다. 볼 자격이 없는 사람의 브라우저에
// 남의 주소가 잠깐이라도 실릴 이유는 없다.
//
// 목록과 총원에는 authorizedFetch 를 쓴다. 두 API 는 지금 토큰을 보지 않지만
// (그래서 이 가드는 화면의 가드일 뿐 서버의 가드가 아니다 — README 의 "알아둘 점"),
// 이 화면은 통째로 관리자 전용이라 세션이 끝났으면 로그인으로 돌아가는 편이 맞다.
// 순위를 못 그린 일이 세션을 끝내면 안 되는 loadBoxOffice() 와 정확히 반대쪽이다.
function setupUserList() {
  // 한 번에 스무 명. limit 은 서버가 1..100 만 받는다.
  var PAGE_SIZE = 20;

  var message = document.getElementById("message");
  var list = document.getElementById("users");
  var pager = document.getElementById("pager");

  // 지금 보고 있는 페이지의 시작 위치와, 거기 그려진 줄 수. 줄 수는 다음 페이지를
  // 불러오다 실패했을 때 버튼을 원래대로 되살리는 데 쓴다.
  var offset = 0;
  var shown = 0;

  // 전체 회원 수. 화면을 열 때 한 번만 센다 — 페이지를 넘길 때마다 다시 세면 그
  // 사이 가입한 사람 때문에 수가 흔들려 지금 보고 있는 목록과 어긋난다. 세지
  // 못하면 null 로 남고, 그때는 마지막 페이지인지를 목록 길이로 짐작한다.
  var total = null;
  var counted = null;

  function show(text, isError) {
    message.textContent = text;
    message.className = isError ? "error" : "ok";
  }

  function toLogin() {
    clearTokens();
    location.replace("login.html");
  }

  function read(response) {
    return response.text().then(function (body) {
      return { ok: response.ok, status: response.status, body: body };
    });
  }

  function parse(body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }

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

  function headCell(row, label, className) {
    row.appendChild(element("th", className, label));
  }

  // 값 칸은 홈의 표와 같은 규칙을 따른다 — 켜진 값은 체크 표시로, 꺼진 값은
  // 글자로 적는다. 다만 선을 그리는 애니메이션은 여기에 없다. 그 움직임은
  // "방금 그렇게 됐다"는 뜻인데, 이 목록의 값은 전부 남이 이미 해 둔 일이다.
  function stateCell(row, on, onLabel, offText) {
    var cell = row.insertCell();
    cell.className = "state";
    if (on) {
      cell.appendChild(checkMark(onLabel, false));
    } else {
      cell.textContent = offText;
    }
  }

  // 표 위 한 줄. 전체가 몇 명인지와 지금 어디를 보고 있는지를 적는다. 총원을
  // 세지 못했으면 세지 못한 대로 적는다 — 모르는 수를 지어내지 않는다.
  function captionText() {
    var range = offset + 1 + "-" + (offset + shown) + "번째";

    if (total == null) {
      return range;
    }
    if (total <= PAGE_SIZE) {
      return "전체 " + total + "명";
    }
    return "전체 " + total + "명 중 " + range;
  }

  function buildTable(rows) {
    var table = element("table", "users");
    table.appendChild(element("caption", null, captionText()));

    // 줄은 표가 아니라 thead/tbody 에 직접 넣는다. table.insertRow() 는 이미 있는
    // 마지막 tr 의 부모에 붙이는 규칙이라, 머리줄을 먼저 만들면 본문 줄까지
    // thead 안으로 들어간다.
    var head = table.createTHead().insertRow();
    headCell(head, "번호", "id");
    headCell(head, "이메일", "email");
    headCell(head, "가입일", "day");
    headCell(head, "이메일 인증", "state");
    headCell(head, "재개봉 알림", "state");

    var body = table.createTBody();
    rows.forEach(function (user) {
      var row = body.insertRow();

      var id = row.insertCell();
      id.className = "id";
      id.textContent = user.id == null ? "" : String(user.id);

      var email = row.insertCell();
      email.className = "email";
      email.textContent = user.email || "";
      // 관리자는 몇 안 되지만 이 화면을 열 수 있는 사람이 누구인지는 목록이
      // 답해야 한다. 칸을 하나 더 세울 값은 아니라 주소 옆에 작게 적는다.
      if (user.isAdmin) {
        email.appendChild(element("small", null, " 관리자"));
      }

      var day = row.insertCell();
      day.className = "day";
      day.textContent = dayText(user.createdAt);

      stateCell(row, user.isEmailVerified, "완료", "미완료");
      stateCell(row, user.receiveReopenBoxOfficeNotifications, "받는 중", "받지 않음");
    });

    return table;
  }

  function pageButton(label, disabled, step) {
    var button = element("button", null, label);
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", function () {
      load(offset + step * PAGE_SIZE);
    });
    return button;
  }

  // 이전/다음. 넘길 곳이 아예 없으면 버튼을 만들지 않는다 — 누를 수 없는 버튼
  // 두 개는 이 화면에서 할 수 있는 일을 잘못 알린다. 넘길 수 있는 동안에는 한쪽이
  // 꺼져 있어도 둘 다 둔다. 버튼이 생겼다 없어지면 다음 페이지를 누르려던 자리가
  // 그때마다 옮겨 간다.
  function drawPager() {
    var more = total == null ? shown === PAGE_SIZE : offset + shown < total;

    pager.textContent = "";

    // 아직 아무것도 그리지 못한 자리에는 버튼을 두지 않는다. 첫 페이지를 불러오다
    // 실패했을 때가 그런데, 총원만 먼저 도착해 있으면 "다음"이 켜진 채 남아
    // 없는 다음 페이지를 가리키게 된다.
    if (!list.firstChild) {
      return;
    }

    if (!offset && !more) {
      return;
    }

    pager.appendChild(pageButton("이전", !offset, -1));
    pager.appendChild(pageButton("다음", !more, 1));
  }

  function lockPager() {
    var buttons = pager.getElementsByTagName("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = true;
    }
  }

  function draw(rows) {
    shown = rows.length;

    list.textContent = "";
    if (shown) {
      list.appendChild(buildTable(rows));
    } else {
      // 첫 페이지가 비는 것은 회원이 하나도 없다는 뜻이고, 뒷 페이지가 비는 것은
      // 총원을 세지 못한 채 "다음"을 짐작으로 열어 둔 경우다. 뜻이 다르니 다르게
      // 적는다 — 뒤쪽은 "이전"이 그대로 남아 있어 눌러서 돌아올 수 있다.
      list.appendChild(
        element(
          "p",
          null,
          offset ? "이 페이지에는 회원이 없습니다." : "아직 회원이 없습니다."
        )
      );
    }

    drawPager();
  }

  // 한 페이지를 불러와 그린다. 실패하면 보고 있던 표는 그대로 두고 버튼만
  // 되살린다 — 다음 페이지를 못 불러온 벌로 지금 페이지까지 사라질 이유가 없다.
  function load(next) {
    lockPager();
    show("회원 목록을 불러오는 중...", false);

    // order=desc 는 최근에 가입한 사람부터다. 이 화면을 여는 이유는 대개
    // "요즘 누가 들어왔나"라서 그쪽을 첫 페이지에 둔다.
    var request = authorizedFetch(
      "/users?limit=" + PAGE_SIZE + "&offset=" + next + "&order=desc"
    ).then(read);

    // 총원이 아직 오지 않았으면 기다렸다 함께 그린다. 표 위 한 줄과 "다음" 버튼이
    // 둘 다 그 수에 달려 있어서, 늦게 받아 고쳐 쓰면 방금 그린 화면을 다시 그리게
    // 된다. 세기에 실패한 약속도 값으로 끝나므로 여기서 먼저 깨지지 않는다.
    Promise.all([request, counted])
      .then(function (values) {
        var result = values[0];

        if (result.status === 401) {
          // 재발급까지 하고도 거절당했다면 세션이 끝난 것이다.
          toLogin();
          return;
        }

        if (!result.ok) {
          show(messageFrom(result.body, result.status), true);
          drawPager();
          return;
        }

        var rows = parse(result.body);
        offset = next;
        show("", false);
        draw(Array.isArray(rows) ? rows : []);
      })
      .catch(function () {
        // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
        if (!localStorage.getItem("accessToken")) {
          location.replace("login.html");
          return;
        }
        show("서버에 연결할 수 없습니다.", true);
        drawPager();
      });
  }

  // 총원을 센다. 실패해도 조용히 넘어간다 — 목록은 멀쩡히 나왔는데 머릿수를 못
  // 셌다고 화면에 에러를 적으면, 보고 있는 목록까지 못 믿을 것처럼 보인다.
  function countUsers() {
    return authorizedFetch("/users/count")
      .then(read)
      .then(function (result) {
        if (!result.ok) {
          return;
        }

        var count = (parse(result.body) || {}).totalUserCount;
        if (typeof count === "number" && isFinite(count) && count >= 0) {
          total = count;
        }
      })
      .catch(function () {
        // 세지 못했다. 목록은 목록대로 그린다.
      });
  }

  // 토큰이 아예 없으면 물어볼 것도 없이 로그인으로 보낸다. 홈과 달리 돌아올 곳을
  // 남기는데, 홈은 로그인하면 어차피 닿는 자리지만 여기는 주소를 알고 찾아온
  // 자리라 로그인시키고 나서 다시 데려다 놓아야 한다.
  if (!hasSession()) {
    location.replace(
      "login.html?next=" +
        encodeURIComponent(location.pathname + location.search)
    );
    return;
  }

  show("회원 목록을 불러오는 중...", false);

  authorizedFetch("/users/me")
    .then(read)
    .then(function (result) {
      if (result.status === 401) {
        toLogin();
        return;
      }

      if (!result.ok) {
        show(messageFrom(result.body, result.status), true);
        return;
      }

      var me = parse(result.body) || {};
      if (!me.isAdmin) {
        // 로그인은 했지만 볼 자격이 없다. 조용히 홈으로 돌려보내면 주소를 잘못
        // 안 것인지 튕겨 난 것인지 알 수 없으므로, 그대로 말하고 아래 링크로
        // 걸어 나가게 둔다.
        show("이 화면은 관리자만 볼 수 있습니다.", true);
        return;
      }

      counted = countUsers();
      load(0);
    })
    .catch(function () {
      // 재발급이 거절되면 토큰이 이미 지워져 있다. 연결 실패와 그걸 가른다.
      if (!localStorage.getItem("accessToken")) {
        location.replace("login.html");
        return;
      }
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
