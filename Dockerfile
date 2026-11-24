FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    CHROME_DEVEL_SANDBOX=/usr/lib/chromium/chrome-sandbox

# 使用清华镜像源（国内网络加速，速度比官方源快数百倍）
# 用 http 避免基础镜像 CA 不信任镜像站证书的问题
RUN sed -i 's|http://deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g; s|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g' \
      /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true

# 系统依赖：Chromium 云浏览器 + Xvfb 虚拟显示 + noVNC 可视化 + 字体
RUN apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fonts-liberation \
      fonts-noto-color-emoji \
      ca-certificates \
      procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node 依赖（puppeteer-core 连接系统 Chromium，无需下载浏览器）
COPY agent/package.json /app/agent/package.json
RUN cd /app/agent && npm install --omit=dev --no-audit --no-fund

COPY agent/agent.js /app/agent/agent.js
COPY agent/public/ /app/agent/public/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# /data 持久化口令与配置（建议挂载卷）
VOLUME ["/data"]

# 6080: noVNC 云浏览器可视化；8787 仅容器内部使用
EXPOSE 6080

ENTRYPOINT ["/app/entrypoint.sh"]
