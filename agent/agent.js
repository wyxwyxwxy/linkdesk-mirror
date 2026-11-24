/**
 * LinkDesk 容器被控端。
 * 职责：
 *  1. 生成/读取持久化口令 code（/data/code）
 *  2. 用 LINKDESK_KEY 调用信令 /api/agent/claim 自动绑定到账号
 *  3. 启动 Chromium 云浏览器；用 CDP screencast 捕获画面
 *  4. 本地 WS 服务：把画面帧推给被控页面 agent.html
 *  5. 接收 agent.html 的键鼠输入，用 CDP 注入到 Chromium
 *
 * 媒体流最终由 agent.html 里的浏览器原生 WebRTC 推给控制端，
 * 与桌面被控端协议完全一致（服务器不接触画面）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { WebSocketServer, WebSocket } = require('ws');

const KEY = (process.env.LINKDESK_KEY || '').trim();
const SIGNAL = (process.env.LINKDESK_SIGNAL || 'https://linkdesk-signal.wyxwy-ml7iihozfn.workers.dev').replace(/\/$/, '');
const KIND = ['browser', 'docker'].includes(process.env.LINKDESK_KIND) ? process.env.LINKDESK_KIND : 'browser';
const NAME = process.env.LINKDESK_NAME || (KIND === 'browser' ? '云浏览器' : 'Docker 容器');
const START_URL = process.env.LINKDESK_URL || 'https://www.bing.com';
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/chromium';
const DATA_DIR = '/data';
const CODE_FILE = path.join(DATA_DIR, 'code');
const PORT = 8787;

function log(...a) { console.log('[linkdesk]', ...a); }

// ---- 持久化口令 ----
function loadOrCreateCode() {
  try {
    const existing = fs.readFileSync(CODE_FILE, 'utf8').trim().toUpperCase();
    if (/^[A-Z0-9-]{6,32}$/.test(existing)) return existing;
  } catch { /* 不存在则创建 */ }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  const code = `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CODE_FILE, code, { mode: 0o600 });
  return code;
}

const CODE = loadOrCreateCode();
log('本机口令:', CODE);

// ---- 自动绑定（带重试） ----
async function claimWithRetry() {
  if (!KEY) { log('未设置 LINKDESK_KEY，跳过自动绑定（可在网页手动绑定上方口令）'); return; }
  const url = `${SIGNAL}/api/agent/claim`;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: KEY, code: CODE, name: NAME, kind: KIND }),
      });
      const data = await res.json();
      if (res.ok && !data.error) { log('自动绑定成功 →', data.email || '账号'); return; }
      if (data.error && data.error.includes('重置')) { log('绑定失败:', data.error); return; }
      log('等待绑定...', data.error || res.status);
    } catch (e) {
      log('信令不可达，重试中:', String(e).slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log('自动绑定超时，容器继续运行');
}

// ---- 键盘映射：浏览器 code → CDP ----
const KEY_MAP = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 },
  ShiftRight: { key: 'Shift', code: 'ShiftRight', windowsVirtualKeyCode: 16, modifiers: 8 },
  ControlLeft: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 },
  ControlRight: { key: 'Control', code: 'ControlRight', windowsVirtualKeyCode: 17, modifiers: 2 },
  AltLeft: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 },
  AltRight: { key: 'Alt', code: 'AltRight', windowsVirtualKeyCode: 18, modifiers: 1 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', windowsVirtualKeyCode: 20 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};
function keyInfo(code, key) {
  if (KEY_MAP[code]) return KEY_MAP[code];
  if (/^Key[A-Z]$/.test(code)) {
    const ch = code.slice(3).toLowerCase();
    return { key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  }
  if (/^Digit\d$/.test(code)) {
    const d = code.slice(5);
    return { key: d, code, windowsVirtualKeyCode: 48 + Number(d), text: d };
  }
  if (/^F\d{1,2}$/.test(code)) {
    return { key: code, code, windowsVirtualKeyCode: 112 + (Number(code.slice(1)) - 1) };
  }
  if (key && key.length === 1) {
    return { key, code: code || '', windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key };
  }
  return { key: key || code, code: code || '', windowsVirtualKeyCode: 0 };
}

let browser, page, cdp;

async function injectInput(ev) {
  if (!cdp) return;
  try {
    switch (ev.t) {
      case 'mouse-move':
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y, button: 'none', buttons: 0 });
        break;
      case 'mouse-move-relative': {
        // 追踪当前位置并叠加相对位移
        injectInput.cur = injectInput.cur || { x: 800, y: 500 };
        injectInput.cur.x = Math.max(0, injectInput.cur.x + ev.dx);
        injectInput.cur.y = Math.max(0, injectInput.cur.y + ev.dy);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: injectInput.cur.x, y: injectInput.cur.y, button: 'none', buttons: 0 });
        break;
      }
      case 'mouse-down':
        injectInput.cur = { x: ev.x, y: ev.y };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ev.x, y: ev.y, button: ev.button, buttons: ev.button === 'right' ? 2 : ev.button === 'middle' ? 4 : 1, clickCount: 1 });
        break;
      case 'mouse-up':
        injectInput.cur = { x: ev.x, y: ev.y };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ev.x, y: ev.y, button: ev.button, buttons: 0, clickCount: 1 });
        break;
      case 'mouse-click': {
        const c = injectInput.cur || { x: 800, y: 500 };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: ev.button, buttons: 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: ev.button, buttons: 0, clickCount: 1 });
        break;
      }
      case 'wheel':
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy });
        break;
      case 'key-down': {
        const k = keyInfo(ev.code, ev.key);
        await cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode, text: k.text });
        break;
      }
      case 'key-up': {
        const k = keyInfo(ev.code, ev.key);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
        break;
      }
      case 'type':
        for (const ch of ev.text) {
          const vk = ch === '\n' ? 13 : ch.toUpperCase().charCodeAt(0);
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, windowsVirtualKeyCode: vk, text: ch });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk });
        }
        break;
      case 'key-combo': {
        const keys = ev.keys.map((n) => keyInfo(n, n));
        for (const k of keys) await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers || 0 });
        for (const k of [...keys].reverse()) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
        break;
      }
      case 'clipboard':
        await cdp.send('Input.insertText', { text: ev.text });
        break;
    }
  } catch (e) {
    log('输入注入错误:', String(e).slice(0, 120));
  }
}

// ---- 本地 HTTP + WebSocket 服务（供被控页面使用） ----
let frameClients = new Set();
let latestFrame = null;

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, code: CODE, kind: KIND, hasFrame: !!latestFrame }));
      return;
    }
    // 被控页面输入回传
    if (req.url === '/input' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { void injectInput(JSON.parse(body)); } catch { /* ignore */ }
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    // 提供被控页面
    if (req.url === '/' || req.url.startsWith('/agent')) {
      const file = path.join(__dirname, 'public', 'agent.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    frameClients.add(ws);
    // 连接后立即发送配置 + 当前帧
    ws.send(JSON.stringify({ type: 'config', code: CODE, signal: SIGNAL }));
    if (latestFrame) ws.send(JSON.stringify({ type: 'frame', data: latestFrame }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input') void injectInput(msg.event);
      } catch { /* ignore */ }
    });
    ws.on('close', () => frameClients.delete(ws));
  });

  server.listen(PORT, '127.0.0.1', () => log('本地服务就绪 :' + PORT));
}

function broadcastFrame(dataUrl) {
  latestFrame = dataUrl;
  const payload = JSON.stringify({ type: 'frame', data: dataUrl });
  for (const ws of frameClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

// ---- 启动 Chromium 与 screencast ----
async function startChromium() {
  log('启动 Chromium 云浏览器...');
  browser = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: false,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--window-size=1600,1000', '--window-position=0,0',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--autoplay-policy=no-user-gesture-required',
      // 防止后台标签页（被控页 agent.html）被节流，保证 canvas 推流帧率
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    defaultViewport: { width: 1600, height: 1000 },
  });
  // 页面 A：云浏览器（被 screencast 捕获、被注入输入）
  page = (await browser.pages())[0] || await browser.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('起始页加载失败:', String(e).slice(0, 80)));
  cdp = await page.createCDPSession();

  // 页面 B：被控页面（跑 WebRTC answer + DataChannel），隐藏标签页
  const agentPage = await browser.newPage();
  await agentPage.goto(`http://127.0.0.1:${PORT}/agent.html`, { waitUntil: 'domcontentloaded' });
  log('被控页面已加载');

  // CDP screencast：事件驱动、增量传输，动态页面可达 20fps（captureScreenshot 在此环境仅 ~1fps）
  await cdp.send('Page.enable');
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    broadcastFrame('data:image/jpeg;base64,' + data);
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 68, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
  });
  log('帧捕获已启动（CDP screencast）');
}

async function main() {
  startServer();
  void claimWithRetry();
  await startChromium();
  log('✅ 容器被控端已就绪。口令:', CODE);
}

main().catch((e) => {
  log('启动失败:', e);
  process.exit(1);
});

process.on('SIGTERM', async () => { try { await browser?.close(); } catch {} process.exit(0); });
