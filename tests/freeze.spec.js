// tests/freeze.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;
const ART_DIR = path.resolve(process.cwd(), 'artifacts');

function nowStr() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/\//g, '-');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function saveDebugArtifacts(page, prefix) {
  try {
    ensureDir(ART_DIR);
    const ts = Date.now();
    const png = path.join(ART_DIR, `${prefix}_${ts}.png`);
    const html = path.join(ART_DIR, `${prefix}_${ts}.html`);

    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(html, await page.content(), 'utf8');

    console.log(`🧾 已保存调试文件:`);
    console.log(`   - ${png}`);
    console.log(`   - ${html}`);
  } catch (e) {
    console.log(`⚠️ 保存调试文件失败: ${e.message}`);
  }
}

function sendTG(result) {
  return new Promise((resolve) => {
    if (!TG_CHAT_ID || !TG_TOKEN) {
      console.log('⚠️ TG_BOT 未配置，跳过推送');
      return resolve();
    }

    const msg = [
      '🎮 FreezeHost 续期通知',
      `🕐 运行时间: ${nowStr()}`,
      '🖥 服务器: FreezeHost Free',
      `📊 结果: ${result}`,
    ].join('\n');

    const body = JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: msg,
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      if (res.statusCode === 200) {
        console.log('📨 TG 推送成功');
      } else {
        console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
      }
      resolve();
    });

    req.on('error', (e) => {
      console.log(`⚠️ TG 推送异常：${e.message}`);
      resolve();
    });

    req.setTimeout(15000, () => {
      console.log('⚠️ TG 推送超时');
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
  try {
    const overlay = page.locator('#review-popup-overlay');
    if (await overlay.count()) {
      const visible = await overlay.isVisible().catch(() => false);
      if (visible) {
        console.log('🪟 检测到评分弹窗，尝试关闭...');
        const closeBtn = page.locator('#review-popup-overlay button').first();
        await closeBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        console.log('✅ 评分弹窗已处理');
      }
    }
  } catch {
    // 忽略
  }
}

async function handleOAuthPage(page) {
  console.log(`  📄 当前 URL: ${page.url()}`);
  await page.waitForTimeout(3000);

  const selectors = [
    'button:has-text("Authorize")',
    'button:has-text("授权")',
    'button[type="submit"]',
    'div[class*="footer"] button',
    'button[class*="primary"]',
  ];

  for (let i = 0; i < 8; i++) {
    console.log(`  🔄 第 ${i + 1} 次尝试，URL: ${page.url()}`);

    if (!page.url().includes('discord.com')) {
      console.log('  ✅ 已离开 Discord');
      return;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    for (const selector of selectors) {
      try {
        const btn = page.locator(selector).last();
        const visible = await btn.isVisible();
        if (!visible) continue;

        const text = (await btn.innerText()).trim();
        console.log(`  🔘 找到按钮: "${text}" (${selector})`);

        if (
          text.includes('取消') ||
          text.toLowerCase().includes('cancel') ||
          text.toLowerCase().includes('deny')
        ) continue;

        const disabled = await btn.isDisabled();
        if (disabled) {
          console.log('  ⏳ 按钮 disabled，等待...');
          break;
        }

        await btn.click();
        console.log(`  ✅ 已点击: "${text}"`);
        await page.waitForTimeout(2000);

        if (!page.url().includes('discord.com')) {
          console.log('  ✅ 授权成功，已跳转');
          return;
        }
        break;
      } catch {
        continue;
      }
    }

    await page.waitForTimeout(2000);
  }

  console.log(`  ⚠️ handleOAuthPage 结束，URL: ${page.url()}`);
}

async function readRenewalStatusWithRetry(page) {
  console.log('⏳ 等待续期状态加载...');

  let renewalStatusText = null;

  // 最多等 8 秒，让 LOADING 变真实内容
  for (let i = 0; i < 8; i++) {
    try {
      const text = await page.locator('#renewal-status-console').innerText();
      console.log(`   第 ${i + 1} 次读取: ${text}`);

      if (text && !text.toLowerCase().includes('loading')) {
        renewalStatusText = text.trim();
        break;
      }
    } catch (e) {
      console.log(`   ⚠️ 读取失败: ${e.message}`);
    }

    await page.waitForTimeout(1000);
  }

  // 8秒后还是拿不到，最后再强制读一次
  if (!renewalStatusText) {
    try {
      renewalStatusText = (await page.locator('#renewal-status-console').innerText()).trim();
    } catch {
      renewalStatusText = null;
    }
  }

  console.log(`📋 续期状态：${renewalStatusText || '获取失败'}`);
  return renewalStatusText;
}

async function openRenewalModal(page) {
  console.log('🔍 查找新版续期入口...');
  const renewTrigger = page.locator('#renew-link-trigger');

  await renewTrigger.waitFor({ state: 'visible', timeout: 10000 });
  await renewTrigger.click();
  console.log('✅ 已点击新版续期入口');

  await page.waitForTimeout(1500);
  await closeReviewPopupIfPresent(page);

  const modalHints = [
    page.getByText(/renewal system/i),
    page.getByText(/current deadline/i),
    page.getByText(/not renewable yet/i),
    page.getByText(/cost breakdown/i),
    page.getByText(/timeline/i),
  ];

  for (const hint of modalHints) {
    if (await hint.first().isVisible().catch(() => false)) {
      console.log('✅ 已检测到 Renewal 弹窗');
      return;
    }
  }

  console.log('⚠️ 未明确识别到 Renewal 弹窗，继续尝试基于页面文本判断');
}

async function renewalModalSaysNotRenewable(page) {
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  return bodyText.includes('not renewable yet');
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

  for (const locator of candidateLocators) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;

        const text = (await el.innerText().catch(() => '')).trim();
        console.log(`👉 尝试点击续期确认控件: "${text || '[无文本]'}"`);

        await el.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {
      // 继续尝试下一组
    }
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

      if (
        text.includes('renew') ||
        text.includes('continue') ||
        text.includes('confirm')
      ) {
        console.log(`👉 兜底点击候选控件: "${text}"`);
        await el.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {
      // 忽略单个元素错误
    }
  }

  return false;
}

test('FreezeHost 自动续期', async () => {
  if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
    throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email,password');
  }

  ensureDir(ART_DIR);

  let proxyConfig = undefined;

  if (process.env.GOST_PROXY) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
          () => resolve()
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.end();
      });

      proxyConfig = { server: process.env.GOST_PROXY };
      console.log('🛡️ 本地代理连通，使用 GOST 转发');
    } catch {
      console.log('⚠️ 本地代理不可达，降级为直连');
    }
  }

  console.log('🔧 启动浏览器...');
  const browser = await chromium.launch({
    headless: true,
    proxy: proxyConfig,
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  console.log('🚀 浏览器就绪！');

  try {
    // 出口 IP 验证
    console.log('🌐 验证出口 IP...');
    try {
      const res = await page.goto('https://api.ipify.org?format=json', {
        waitUntil: 'domcontentloaded',
      });
      const body = await res.text();
      const ip = JSON.parse(body).ip || body;
      const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
      console.log(`✅ 出口 IP 确认：${masked}`);
    } catch {
      console.log('⚠️ IP 验证超时，跳过');
    }

    // 登录 FreezeHost
    console.log('🔑 打开 FreezeHost 登录页...');
    await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });

    console.log('📤 点击 Login with Discord...');
    await page.click('span.text-lg:has-text("Login with Discord")');

    console.log('⏳ 等待服务条款弹窗...');
    const confirmBtn = page.locator('button#confirm-login');
    await confirmBtn.waitFor({ state: 'visible' });
    await confirmBtn.click();
    console.log('✅ 已接受服务条款');

    console.log('⏳ 等待跳转 Discord 登录页...');
    await page.waitForURL(/discord\.com\/login/);

    console.log('✏️ 填写账号密码...');
    await page.fill('input[name="email"]', DISCORD_EMAIL);
    await page.fill('input[name="password"]', DISCORD_PASSWORD);

    console.log('📤 提交登录请求...');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);

    if (/discord\.com\/login/.test(page.url())) {
      let err = '账密错误或触发了 2FA / 验证码';
      try {
        err = await page.locator('[class*="errorMessage"]').first().innerText();
      } catch {}

      await saveDebugArtifacts(page, 'discord_login_failed');
      await sendTG(`❌ Discord 登录失败：${err}`);
      throw new Error(`❌ Discord 登录失败: ${err}`);
    }

    // OAuth 授权
    console.log('⏳ 等待 OAuth 授权...');
    try {
      await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
      console.log('🔍 进入 OAuth 授权页，处理中...');
      await page.waitForTimeout(2000);

      if (page.url().includes('discord.com')) {
        await handleOAuthPage(page);
      } else {
        console.log('✅ 已自动完成授权，无需手动点击');
      }

      await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
      console.log(`✅ 已离开 Discord，当前：${page.url()}`);
    } catch {
      console.log(`✅ 静默授权或已跳转，当前：${page.url()}`);
    }

    // Dashboard
    console.log('⏳ 确认到达 Dashboard...');
    try {
      await page.waitForURL(
        url => url.includes('/callback') || url.includes('/dashboard'),
        { timeout: 10000 }
      );
    } catch {}

    if (page.url().includes('/callback')) {
      await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
    }

    if (!page.url().includes('/dashboard')) {
      await saveDebugArtifacts(page, 'dashboard_not_reached');
      throw new Error(`❌ 未到达 Dashboard，当前 URL: ${page.url()}`);
    }

    console.log(`✅ 登录成功！当前：${page.url()}`);

    // 进入 Server Console
    console.log('🔍 查找 Manage 按钮...');
    await page.waitForTimeout(3000);

    const serverUrl = await page.evaluate(() => {
      const link = document.querySelector('a[href*="server-console"]');
      return link ? link.href : null;
    });

    if (!serverUrl) {
      await saveDebugArtifacts(page, 'server_console_link_missing');
      throw new Error('❌ 未找到 server-console 链接');
    }

    console.log(`✅ 找到链接：${serverUrl}`);
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    console.log(`✅ 已跳转到 Server Console: ${page.url()}`);

    await page.waitForTimeout(3000);
    await closeReviewPopupIfPresent(page);

    // 读取续期状态（带 8 秒重试）
    console.log('🔍 读取续期状态...');
    const renewalStatusText = await readRenewalStatusWithRetry(page);

    const remainingDays = parseRemainingDays(renewalStatusText);

    if (remainingDays !== null) {
      console.log(`⏳ 精确剩余时间：${remainingDays.toFixed(2)} 天`);

      if (remainingDays > 7) {
        const msg = `⏰ 剩余 ${remainingDays.toFixed(2)} 天，未到续期时间（需 ≤7 天才续期）`;
        console.log(msg);
        await sendTG(msg);
        return;
      }

      console.log(`✅ 剩余 ${remainingDays.toFixed(2)} 天，进入续期检查...`);
    } else {
      console.log('⚠️ 无法解析剩余时间，继续打开 Renewal 弹窗做二次判断...');
    }

    // 打开新版 Renewal 弹窗
    await openRenewalModal(page);
    await saveDebugArtifacts(page, 'renewal_modal_opened');

    // 二次判断：页面明确说不能续期
    if (await renewalModalSaysNotRenewable(page)) {
      const msg = '⏰ 当前显示 NOT RENEWABLE YET，未到续期时间';
      console.log(msg);
      await sendTG(msg);
      return;
    }

    // 点击真正的续期按钮
    console.log('🔍 尝试点击弹窗中的真正续期按钮...');
    const clicked = await clickActualRenewButton(page);

    if (!clicked) {
      await saveDebugArtifacts(page, 'renew_confirm_not_found');
      const msg = '⚠️ 已打开 Renewal 弹窗，但未找到真正的续期确认按钮';
      console.log(msg);
      await sendTG(msg);
      throw new Error(msg);
    }

    console.log('📤 已提交续期操作，等待结果...');
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const pageText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

    if (
      finalUrl.includes('success=RENEWED') ||
      pageText.includes('success') ||
      pageText.includes('renewed')
    ) {
      console.log('🎉 续期成功！');
      await sendTG('✅ 续期成功！');
      expect(true).toBeTruthy();
      return;
    }

    if (
      finalUrl.includes('err=CANNOTAFFORDRENEWAL') ||
      pageText.includes('cannot afford')
    ) {
      console.log('⚠️ 余额不足，无法续期');
      await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币');
      return;
    }

    if (
      finalUrl.includes('err=TOOEARLY') ||
      pageText.includes('not renewable yet')
    ) {
      console.log('⏰ 尚未到续期时间，无需操作');
      await sendTG('⏰ 尚未到续期时间，今日已续期或暂不需要续期');
      return;
    }

    // 再读一次状态做兜底
    try {
      const refreshedStatus = await page.locator('#renewal-status-console').innerText({ timeout: 5000 });
      console.log(`📋 续期后状态：${refreshedStatus || '[空]'}`);
      if (/renewed/i.test(refreshedStatus || '')) {
        console.log('🎉 根据状态文本判断，续期成功');
        await sendTG('✅ 续期成功！（根据状态文本判断）');
        return;
      }
    } catch {}

    await saveDebugArtifacts(page, 'renewal_unknown_result');
    await sendTG(`⚠️ 续期结果未知：${finalUrl}`);
    throw new Error(`续期结果未知，URL: ${finalUrl}`);

  } catch (e) {
    await saveDebugArtifacts(page, 'freeze_exception');
    if (!String(e.message || '').includes('余额不足')) {
      await sendTG(`❌ 脚本异常：${e.message}`);
    }
    throw e;
  } finally {
    await browser.close();
  }
});
