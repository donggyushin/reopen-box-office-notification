#!/usr/bin/env python3
"""로컬 확인용 정적 서버.

python3 -m http.server 를 쓰지 않는 이유가 있다. 그쪽은 Cache-Control 을
아예 보내지 않아서, 브라우저가 제 판단으로 auth.js 를 재검증 없이 계속
재사용한다. 그러면 새 HTML 과 옛 JS 가 짝지어져 함수가 없다는 에러만
나고 화면은 조용히 빈다. 원인을 찾기 어려운 종류의 고장이라 아예 캐시를
끈다.
"""

import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        # 이미 브라우저에 남아 있는 옛 사본이 304 로 되살아나지 않게
        # 조건부 요청은 버리고 언제나 본문을 새로 보낸다.
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return http.server.SimpleHTTPRequestHandler.send_head(self)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        http.server.SimpleHTTPRequestHandler.end_headers(self)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
http.server.test(HandlerClass=Handler, port=port, bind="127.0.0.1")
