const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync('index.html', 'utf8'));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

let browser;

async function getBrowser() {
  if (!browser || !browser.process() || browser.process().exitCode !== null) {
    console.log('🚀 Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-clipboard-read',
        '--enable-clipboard-write',
      ],
      userDataDir: './profile'
    });
  }
  return browser;
}

async function handleClient(ws) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto('https://chatgpt.com/?model=gpt-4');

  // Cấp quyền clipboard
  const client = await page.target().createCDPSession();
  await client.send('Browser.grantPermissions', {
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    origin: 'https://chatgpt.com',
  });

  // --- Theo dõi clipboard hệ thống ---
  let lastClipboard = '';
  setInterval(async () => {
    try {
      const text = await page.evaluate(async () => {
        try {
          return await navigator.clipboard.readText();
        } catch {
          return null;
        }
      });
      if (text && text !== lastClipboard) {
        lastClipboard = text;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'clipboard', text }));
          console.log('📋 Clipboard (poll):', text);
        }
      }
    } catch (_) { }
  }, 1000); // kiểm tra mỗi 1 giây

  // --- Stream ảnh màn hình ---
  let capturing = true;
  (async function loop() {
    while (capturing && ws.readyState === WebSocket.OPEN) {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
        ws.send(JSON.stringify({ type: 'frame', image: buf.toString('base64') }));
      } catch (e) {
        console.error('Screenshot error:', e.message);
      }
      await new Promise(r => setTimeout(r, 150));
    }
  })();

  // --- Nhận lệnh từ client ---
  ws.on('message', async msg => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'mouse') {
        const { subtype, x, y, button } = data;
        if (subtype === 'move') await page.mouse.move(x, y);
        else if (subtype === 'down') await page.mouse.down({ button });
        else if (subtype === 'up') await page.mouse.up({ button });
        else if (subtype === 'wheel') await page.mouse.wheel({ deltaY: data.deltaY });
      }

      if (data.type === 'key') {
        if (data.subtype === 'press') await page.keyboard.press(data.key);
        else if (data.subtype === 'down') await page.keyboard.down(data.key);
        else if (data.subtype === 'up') await page.keyboard.up(data.key);
      }

      if (data.type === 'clipboard') {
        await page.evaluate(async text => {
          // Tạo event paste mô phỏng với dữ liệu thật
          const event = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: new DataTransfer(),
          });
          event.clipboardData.setData('text/plain', text);
          document.activeElement.dispatchEvent(event);

          // Dán trực tiếp nếu có thể (giả lập Ctrl+V)
          if (document.activeElement && document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') {
            document.activeElement.value += text;
          }
        }, data.text);
        console.log('📋 Giả lập paste:', data.text);
      }


      if (data.type === 'navigate') await page.goto(data.url);
    } catch (e) {
      console.error(e);
    }
  });

  ws.on('close', async () => {
    capturing = false;
    try {
      await page.close();
    } catch { }
  });
}

wss.on('connection', ws => handleClient(ws));

process.on('exit', async () => {
  if (browser && browser.process() && browser.process().exitCode === null) {
    await browser.close();
  }
});

server.listen(3000, () => console.log('🌐 Server running at http://localhost:3000'));
