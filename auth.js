// 백엔드 API 주소
var API_BASE = "https://donggyu-sworld-production.up.railway.app";

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

// JWT 페이로드에서 email을 꺼낸다.
// 서명 검증은 서버 몫이고, 여기서는 표시용으로만 쓴다.
function readEmail(jwt) {
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
    return JSON.parse(json).email || "";
  } catch (e) {
    return "";
  }
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
