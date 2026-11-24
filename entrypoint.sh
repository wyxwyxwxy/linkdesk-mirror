#!/bin/bash
set -e

# 默认参数
: "${LINKDESK_KIND:=browser}"        # browser=云浏览器 / docker=被控容器
: "${LINKDESK_SIGNAL:=https://linkdesk-signal.wyxwy-ml7iihozfn.workers.dev}"
: "${LINKDESK_NAME:=}"
: "${LINKDESK_URL:=https://www.bing.com}"
: "${DISPLAY:=:99}"
export DISPLAY

mkdir -p /data

echo "=============================================="
echo " LinkDesk Container Agent"
echo " kind   : ${LINKDESK_KIND}"
echo " signal : ${LINKDESK_SIGNAL}"
echo "=============================================="

# 1) 启动虚拟显示
Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp &
sleep 1

# 2) 启动 noVNC（可通过 http://<host>:6080 直接看容器浏览器画面）
x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw >/tmp/x11vnc.log 2>&1 &
# Debian novnc 包路径为 /usr/share/novnc（小写），入口 vnc.html
NOVNC_DIR=/usr/share/novnc
[ -d /usr/share/noVNC ] && NOVNC_DIR=/usr/share/noVNC
websockify --web="$NOVNC_DIR" 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

# 3) 启动被控端 Node 程序（它会拉起 Chromium、自动绑定、连信令）
exec node /app/agent/agent.js
