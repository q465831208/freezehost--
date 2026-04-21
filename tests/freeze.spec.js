const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DISCORD_EMAIL = process.env.DISCORD_EMAIL || '';
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_TOKEN = process.env.TG_TOKEN || '';
const LEGACY_DISCORD_ACCOUNT = process.env.DISCORD_ACCOUNT || '';
const LEGACY_TG_BOT = process.env.TG_BOT || '';
const LOCAL_PROXY = process.env.GOST_PROXY || '';

const TIMEOUT = 60000;
const ART_DIR = path.resolve(process.cwd(), 'artifacts');
const BASE_URL = 'https://free.freezehost.pro';
const DASHBOARD_URL_RE = /https:\/\/free\.freezehost\.pro\/(callback|dashboard)/i;

function nowStr() {
  return new Date()
    .toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    .replace(/\//g, '-');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function maskIp(ip) {
  return String(ip || '').replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
}

function parseLegacyPair(raw) {
  if (!raw) return ['', ''];
  const idx = raw.indexOf(',');
  if (idx === -1) return [raw.trim(), ''];
  return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()];
}

function getDiscordCreds() {
  if (DISCORD_EMAIL && DISCORD_PASSWORD) return [DISCORD_EMAIL, DISCORD_PASSWORD];
  return parseLegacyPair(LEGACY_DISCORD_ACCOUNT);
}

function getTelegramCreds() {
  if (TG_CHAT_ID && TG_TOKEN) return [TG_CHAT_ID, TG_TOKEN];
  return parseLegacyPair(LEGACY_TG_BOT);
}

async function saveDebugArtifacts(page, prefix) {
  try {
    ensureDir(ART_DIR);
    const ts = Date.now();
    const png = path.join(ART_DIR, `${prefix}_${ts}.png`);
    const html = path.join(ART_DIR, `${prefix}_${ts}.html`);
    const meta = path.join(ART_DIR, `${prefix}_${ts}.json`);

    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(html, await page.content(), 'utf8');
    fs.writeFileSync(
      meta,
      JSON.stringify(
        {
          url: page.url(),
          title: await page.title().catch(() => ''),
          saved_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log('🧾 已保存调试文件:');
    console.log(`   - ${png}`);
    console.log(`   - ${html}`);
    console.log(`   - ${meta}`);
  } catch (e) {
    console.log(`⚠️ 保存调试文件失败: ${e.message}`);
  }
}

function sendTG(result) {
  return new Promise((resolve) => {
    const [chatId, token] = getTelegramCreds();
    if (!chatId || !token) {
      console.log('⚠️ Telegram 未配置，跳过推送');
      return resolve();
    }

    const msg = [
      '🎮 FreezeHost 续期通知',
      `🕐 运行时间: ${nowStr()}`,
      '🖥 服务器: FreezeHost Free',
      `📊 结果: ${result}`,
    ].join('\n');

    const body = JSON.stringify({ chat_id: chatId, text: msg });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => {
          chunks += d.toString();
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('📨 Telegram 推送成功');
          } else {
            console.log(`⚠️ Telegram 推送失败：HTTP ${res.statusCode} ${chunks.slice(0, 200)}`);
          }
          resolve();
        });
      },
    );

    req.on('error', (e) => {
      console.log(`⚠️ Telegram 推送异常：${e.message}`);
      resolve();
    });

    req.setTimeout(15000, () => {
      console.log('⚠️ Telegram 推送超时');
      req.destroy();
      resolve();
    });

    req.write(body);
    req.end();
  });
}

function parseRemainingDays(text) {
  if (!text) return null;

  const normalized = text.replace(/\s+/g, ' ').trim();
  const dayMatch = normalized.match(/(\d+(?:\.\d+)?)\s*days?/i);
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/i);

  if (!dayMatch && !hourMatch) return null;

  const days = dayMatch ? parseFloat(dayMatch[1]) : 0;
  const hours = hourMatch ? parseFloat(hourMatch[1]) : 0;
  return days + hours / 24;
}

async function closeReviewPopupIfPresent(page) {
  const candidates = [
    '#review-popup-overlay button',
    '[id*="review"] button',
    '[class*="review"] button',
    'button[aria-label="Close"]',
    'button:has-text("Close")',
    'button:has-text("×")',
  ];

  for (const selector of candidates) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`🪟 检测到弹窗，尝试关闭：${selector}`);
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);
        return;
      }
    } catch {
      // ignore
    }
  }
}

async function clickFirstVisible(page, locators, desc) {
  for (const locator of locators) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);
        const visible = await item.isVisible().catch(() => false);
        if (!visible) continue;
        const text = (await item.innerText().catch(() => '')).trim();
        console.log(`👉 尝试点击${desc}: ${text || '[无文本]'} `);
        await item.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
}

async function openFreezeLogin(page) {
  console.log('🔑 打开 FreezeHost 首页...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await closeReviewPopupIfPresent(page);

  const clicked = await clickFirstVisible(
    page,
    [
      page.getByRole('button', { name: /login with discord/i }),
      page.getByRole('link', { name: /login with discord/i }),
      page.locator('button:has-text("Login with Discord")'),
      page.locator('a:has-text("Login with Discord")'),
      page.locator('span:has-text("Login with Discord")'),
    ],
    'FreezeHost 登录入口',
  );

  if (!clicked) {
    await saveDebugArtifacts(page, 'freeze_login_button_missing');
    throw new Error('未找到 Login with Discord 入口');
  }

  const confirmBtn = page.locator('button#confirm-login, button:has-text("Confirm"), button:has-text("Continue")').first();
  if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmBtn.click({ timeout: 5000 });
    console.log('✅ 已接受服务条款/确认弹窗');
  }
}

async function loginDiscord(page, email, password) {
  console.log('⏳ 等待进入 Discord 登录/OAuth...');
  await page.waitForURL(/discord\.com\//, { timeout: 30000 });
  await page.waitForTimeout(1500);

  if (/discord\.com\/login/i.test(page.url())) {
    console.log('✏️ 填写 Discord 账号密码...');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2500);
  } else {
    console.log('✅ 已不是纯登录页，可能已有登录态或直接到 OAuth');
  }

  if (/discord\.com\/login/i.test(page.url())) {
    const maybeError = await page
      .locator('[class*="error"], [class*="notice"], [class*="message"]')
      .first()
      .innerText()
      .catch(() => '仍停留在 Discord 登录页，可能触发验证码 / 2FA / 风控 / 账密错误');

    await saveDebugArtifacts(page, 'discord_login_failed');
    throw new Error(`Discord 登录未完成：${maybeError}`);
  }
}

async function handleOAuthPage(page) {
  console.log(`🔐 OAuth 处理开始，当前 URL: ${page.url()}`);

  for (let i = 0; i < 10; i++) {
    if (!page.url().includes('discord.com')) {
      console.log('✅ 已离开 Discord 域名');
      return;
    }

    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

    const clicked = await clickFirstVisible(
      page,
      [
        page.getByRole('button', { name: /authorize/i }),
        page.getByRole('button', { name: /授权/i }),
        page.locator('button[type="submit"]'),
        page.locator('button[class*="primary"]'),
      ],
      'Discord 授权按钮',
    );

    if (clicked) {
      await page.waitForTimeout(2500);
    }

    if (!page.url().includes('discord.com')) {
      console.log('✅ 已从 Discord 返回');
      return;
    }
  }

  console.log(`⚠️ OAuth 处理结束但仍在 Discord：${page.url()}`);
}

async function ensureDashboard(page) {
  console.log('⏳ 等待返回 FreezeHost Dashboard...');

  try {
    await page.waitForURL(DASHBOARD_URL_RE, { timeout: 25000 });
  } catch {
    if (page.url().includes('discord.com')) {
      await handleOAuthPage(page);
    }
  }

  if (page.url().includes('/callback')) {
    await page.waitForURL(/free\.freezehost\.pro\/dashboard/i, { timeout: 20000 }).catch(() => {});
  }

  if (!page.url().includes('/dashboard')) {
    await saveDebugArtifacts(page, 'dashboard_not_reached');
    throw new Error(`未到达 Dashboard，当前 URL: ${page.url()}`);
  }

  console.log(`✅ 已到达 Dashboard：${page.url()}`);
}

async function getServerConsoleUrl(page) {
  await page.waitForTimeout(2500);
  await closeReviewPopupIfPresent(page);

  const href = await page.evaluate(() => {
    const selectors = [
      'a[href*="server-console"]',
      'a[href*="manage"]',
      'a[href*="console"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.href) return el.href;
    }
    return null;
  });

  if (!href) {
    await saveDebugArtifacts(page, 'server_console_link_missing');
    throw new Error('未找到 server-console/manage 链接');
  }

  return href;
}

async function openRenewalModal(page) {
  console.log('🔍 查找续期入口...');

  const clicked = await clickFirstVisible(
    page,
    [
      page.locator('#renew-link-trigger'),
      page.getByRole('button', { name: /renew/i }),
      page.getByRole('link', { name: /renew/i }),
      page.locator('a:has-text("Renew")'),
      page.locator('button:has-text("Renew")'),
    ],
    '续期入口',
  );

  if (!clicked) {
    await saveDebugArtifacts(page, 'renew_entry_missing');
    throw new Error('未找到续期入口');
  }

  await page.waitForTimeout(1500);
  await closeReviewPopupIfPresent(page);

  const modalHints = [
    page.getByText(/renewal system/i),
    page.getByText(/current deadline/i),
    page.getByText(/not renewable yet/i),
    page.getByText(/cost breakdown/i),
    page.getByText(/timeline/i),
    page.getByText(/renew instance/i),
  ];

  for (const hint of modalHints) {
    if (await hint.first().isVisible().catch(() => false)) {
      console.log('✅ 已识别到 Renewal 弹窗');
      return;
    }
  }

  console.log('⚠️ 未明确识别到 Renewal 弹窗，继续基于全文判断');
}

async function renewalModalSaysNotRenewable(page) {
  const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
  return bodyText.includes('not renewable yet') || bodyText.includes('too early');
}

async function clickActualRenewButton(page) {
  const candidateLocators = [
    page.getByRole('button', { name: /renew instance/i }),
    page.getByRole('button', { name: /^renew$/i }),
    page.getByRole('button', { name: /continue/i }),
    page.getByRole('button', { name: /confirm/i }),
    page.locator('a:has-text("Renew Instance")'),
    page.locator('a:has-text("Renew")'),
  ];

  const clicked = await clickFirstVisible(page, candidateLocators, '续期确认控件');
  if (clicked) {
    await page.waitForTimeout(2500);
    return true;
  }

  const genericCandidates = page.locator('button, a');
  const total = await genericCandidates.count();
  for (let i = 0; i < total; i++) {
    try {
      const el = genericCandidates.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = ((await el.innerText().catch(() => '')) || '').trim().toLowerCase();
      if (!text) continue;
      if (text.includes('renew') || text.includes('continue') || text.includes('confirm')) {
        console.log(`👉 兜底点击候选控件: ${text}`);
        await el.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
        return true;
      }
    } catch {
      // ignore single candidate failure
    }
  }

  return false;
}

async function probeLocalProxy() {
  if (!LOCAL_PROXY) return null;

  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: 8080,
          path: '/',
          method: 'GET',
          timeout: 3000,
        },
        () => resolve(),
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.end();
    });
    console.log(`🛡️ 本地代理连通，浏览器将使用: ${LOCAL_PROXY}`);
    return { server: LOCAL_PROXY };
  } catch (e) {
    console.log(`⚠️ 本地代理探测失败，降级直连: ${e.message}`);
    return null;
  }
}

async function readBodyText(page) {
  return ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
}

test('FreezeHost 自动续期', async () => {
  const [email, password] = getDiscordCreds();
  if (!email || !password) {
    throw new Error('缺少 Discord 凭据。推荐使用 DISCORD_EMAIL + DISCORD_PASSWORD；兼容旧格式 DISCORD_ACCOUNT=email,password');
  }

  ensureDir(ART_DIR);

  const proxyConfig = await probeLocalProxy();
  console.log('🔧 启动浏览器...');
  const browser = await chromium.launch({
    headless: true,
    proxy: proxyConfig || undefined,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    console.log('🌐 验证出口 IP...');
    try {
      const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const body = await res.text();
      const ip = JSON.parse(body).ip || body;
      console.log(`✅ 出口 IP: ${maskIp(ip)}`);
    } catch {
      console.log('⚠️ IP 验证失败，跳过');
    }

    await openFreezeLogin(page);
    await loginDiscord(page, email, password);
    await handleOAuthPage(page);
    await ensureDashboard(page);

    const serverUrl = await getServerConsoleUrl(page);
    console.log(`✅ 找到服务器控制台链接: ${serverUrl}`);
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await closeReviewPopupIfPresent(page);

    console.log('🔍 读取续期状态...');
    const renewalStatusText = await page.locator('#renewal-status-console').innerText().catch(() => null);
    console.log(`📋 续期状态：${renewalStatusText || '[空]'}`);

    const remainingDays = parseRemainingDays(renewalStatusText);
    if (remainingDays !== null) {
      console.log(`⏳ 精确剩余时间：${remainingDays.toFixed(2)} 天`);
      if (remainingDays > 7) {
        const msg = `⏰ 剩余 ${remainingDays.toFixed(2)} 天，未到续期时间（需 ≤7 天才续期）`;
        console.log(msg);
        await sendTG(msg);
        return;
      }
    } else {
      console.log('⚠️ 无法从状态文本解析剩余时间，继续打开续期弹窗进行二次判断');
    }

    await openRenewalModal(page);
    await saveDebugArtifacts(page, 'renewal_modal_opened');

    if (await renewalModalSaysNotRenewable(page)) {
      const msg = '⏰ 当前显示 NOT RENEWABLE YET，未到续期时间';
      console.log(msg);
      await sendTG(msg);
      return;
    }

    console.log('🔍 尝试点击真正的续期按钮...');
    const clicked = await clickActualRenewButton(page);
    if (!clicked) {
      await saveDebugArtifacts(page, 'renew_confirm_not_found');
      const msg = '⚠️ 已打开 Renewal 弹窗，但未找到真正的续期确认按钮';
      console.log(msg);
      await sendTG(msg);
      throw new Error(msg);
    }

    console.log('📤 已提交续期操作，等待结果...');
    await page.waitForTimeout(3500);

    const finalUrl = page.url();
    const pageText = await readBodyText(page);

    if (finalUrl.includes('success=RENEWED') || pageText.includes('successfully renewed') || pageText.includes('renewed successfully')) {
      console.log('🎉 续期成功');
      await sendTG('✅ 续期成功！');
      expect(true).toBeTruthy();
      return;
    }

    if (finalUrl.includes('err=CANNOTAFFORDRENEWAL') || pageText.includes('cannot afford')) {
      console.log('⚠️ 余额不足，无法续期');
      await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币');
      return;
    }

    if (finalUrl.includes('err=TOOEARLY') || pageText.includes('not renewable yet')) {
      console.log('⏰ 尚未到续期时间');
      await sendTG('⏰ 尚未到续期时间，今日无需续期');
      return;
    }

    try {
      const refreshedStatus = await page.locator('#renewal-status-console').innerText({ timeout: 5000 });
      console.log(`📋 续期后状态：${refreshedStatus || '[空]'}`);
      if (/renewed/i.test(refreshedStatus || '')) {
        console.log('🎉 根据状态文本判断，续期成功');
        await sendTG('✅ 续期成功！（根据状态文本判断）');
        return;
      }
    } catch {
      // ignore
    }

    await saveDebugArtifacts(page, 'renewal_unknown_result');
    await sendTG(`⚠️ 续期结果未知：${finalUrl}`);
    throw new Error(`续期结果未知，URL: ${finalUrl}`);
  } catch (e) {
    await saveDebugArtifacts(page, 'freeze_exception');
    await sendTG(`❌ 脚本异常：${e.message}`);
    throw e;
  } finally {
    await browser.close();
  }
});
