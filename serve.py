#!/usr/bin/env python3
"""로컬 확인용 정적 서버.

python3 -m http.server 를 쓰지 않는 이유가 둘 있다.

하나. 그쪽은 Cache-Control 을 아예 보내지 않아서, 브라우저가 제 판단으로
auth.js 를 재검증 없이 계속 재사용한다. 그러면 새 HTML 과 옛 JS 가 짝지어져
함수가 없다는 에러만 나고 화면은 조용히 빈다. 원인을 찾기 어려운 고장이라
아예 캐시를 끈다.

둘. /email/verification/<코드> 는 메일 링크로 들어오는 실주소인데, 정적
서버에는 rewrite 가 없어 404 가 난다. vercel.json 의 규칙을 그대로 읽어
로컬에서도 같은 주소로 열리게 한다.
"""

import http.server
import io
import json
import re
import sys


def load_rewrites(path="vercel.json"):
    """vercel.json 의 rewrites 를 (정규식, 목적지) 목록으로 바꾼다.

    규칙을 여기에 옮겨 적으면 배포와 갈라지므로 원본을 읽는다.
    :param 한 조각만 다루면 충분하다. vercel.json 에 그 이상이 없다.
    """
    try:
        with io.open(path, encoding="utf-8") as config_file:
            config = json.load(config_file)
    except (IOError, ValueError):
        return []

    rewrites = []
    for rule in config.get("rewrites", []):
        source = rule.get("source")
        destination = rule.get("destination")
        if not source or not destination:
            continue
        parts = [
            "[^/]+" if segment.startswith(":") else re.escape(segment)
            for segment in source.split("/")
        ]
        rewrites.append((re.compile("^" + "/".join(parts) + "/?$"), destination))
    return rewrites


REWRITES = load_rewrites()


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        # 이미 브라우저에 남아 있는 옛 사본이 304 로 되살아나지 않게
        # 조건부 요청은 버리고 언제나 본문을 새로 보낸다.
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]

        # 쿼리와 프래그먼트를 뗀 경로로만 규칙을 맞춘다.
        # 주소창은 그대로 두므로 페이지는 경로 끝의 코드를 그대로 읽는다.
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        for pattern, destination in REWRITES:
            if pattern.match(path):
                self.path = destination
                break

        return http.server.SimpleHTTPRequestHandler.send_head(self)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        http.server.SimpleHTTPRequestHandler.end_headers(self)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
http.server.test(HandlerClass=Handler, port=port, bind="127.0.0.1")
