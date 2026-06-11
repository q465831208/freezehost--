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

    console.log(`🧾 已保存调试文件:\n   - ${png}\n   - ${html}`);
  } catch (e) {
    console.log(`⚠️ 保存调试文件失败: ${e.message}`);
  }
}

function sendTG(result, remainingDays = null) {
  return new Promise((resolve) => {
    if (!TG_CHAT_ID || !TG_TOKEN) {
      console.log('⚠️ TG_BOT 未配置，跳过推送');
      return resolve();
    }

    const msgLines = [
      '🎮 FreezeHost 续期通知',
      `🕐 运行时间: ${nowStr()}`,
      '🖥 服务器: FreezeHost Free',
      `📊 结果: ${result}`,
    ];

    if (typeof remainingDays === 'number') {
      msgLines.push(`⏳ 剩余时间: ${remainingDays.toFixed(2)} 天`);
    }

    const msg = msgLines.join('\n');

    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      console.log(res.statusCode === 200 ? '📨 TG 推送成功' : `⚠️ TG 推送失败：HTTP ${res.statusCode}`);
      resolve();
    });

    req.on('error', (e) => { console.log(`⚠️ TG 推送异常：${e.message}`); resolve(); });
    req.setTimeout(15000, () => { console.log('⚠️ TG 推送超时'); req.destroy(); resolve(); });
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

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function closeReviewPopupIfPresent(page) {
  try {
    const overlay = page.locator('#review-popup-overlay');
    if (await overlay.count()) {
      if (await overlay.isVisible().catch(() => false)) {
        console.log('🪟 检测到评分弹窗，尝试关闭...');
        await page.locator('#review-popup-overlay button').first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        console.log('✅ 评分弹窗已处理');
      }
    }
  } catch {}
}

async function handleOAuthPage(page) {
  console.log(`  📄 当前 URL: ${page.url()}`);
  await page.waitForTimeout(3000);

  const selectors = ['button:has-text("Authorize")', 'button:has-text("授权")', 'button[type="submit"]', 'div[class*="footer"] button', 'button[class*="primary"]'];

  for (let i = 0; i < 8; i++) {
    console.log(`  🔄 第 ${i + 1} 次尝试，URL: ${page.url()}`);
    if (!page.url().includes('discord.com')) return;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    for (const selector of selectors) {
      try {
        const btn = page.locator(selector).last();
        if (!(await btn.isVisible())) continue;

        const text = (await btn.innerText()).trim();
        if (text.includes('取消') || text.toLowerCase().includes('cancel') || text.toLowerCase().includes('deny')) continue;
        if (await btn.isDisabled()) break;

        await btn.click();
        console.log(`  ✅ 已点击: "${text}"`);
        await page.waitForTimeout(2000);
        if (!page.url().includes('discord.com')) return;
        break;
      } catch {}
    }
    await page.waitForTimeout(2000);
  }
}

async function renewalModalSaysNotRenewable(page) {
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  return bodyText.includes('not renewable yet') || bodyText.includes('too early');
}

// ============== 下方为你提供的新版核心组件 ==============

async function openRenewalModal(page) {
  console.log('🔍 查找新版续期入口...');
  await closeReviewPopupIfPresent(page);

  const renewTrigger = page.locator([
    '#renew-link-trigger',
    'a:has-text("Renew")',
    'button:has-text("Renew")',
    '[data-modal-target*="renew"]',
    '[data-modal-toggle*="renew"]',
  ].join(', ')).first();

  await expect(renewTrigger).toBeVisible({ timeout: 10000 });
  await renewTrigger.scrollIntoViewIfNeeded().catch(() => {});
  await renewTrigger.click();
  console.log('✅ 已点击 Renew 按钮');

  await closeReviewPopupIfPresent(page);

  const modalCandidates = [
    page.locator('#renew-modal'),
    page.locator('#renew-link-modal'),
    page.locator('[id*="renew"][role="dialog"]'),
    page.locator('[role="dialog"]').filter({ hasText: /renew|confirm|not renewable|too early/i }),
    page.locator('div.fixed').filter({ hasText: /renew|confirm|not renewable|too early/i }),
    page.locator('form[action*="/api/renew"]'),
    page.locator('a[href*="/renew?id="]'),
    page.locator('a[href*="../renew?id="]'),
    page.getByRole('button', { name: /confirm/i }),
  ];

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (/success=RENEWED|err=/i.test(page.url())) {
      console.log('✅ 点击 Renew 后页面已直接返回续期结果');
      return;
    }

    for (const locator of modalCandidates) {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        if (await locator.nth(i).isVisible().catch(() => false)) {
          console.log('✅ 已检测到 Renew Server 确认弹窗/确认控件');
          return;
        }
      }
    }

    if (await renewalModalSaysNotRenewable(page).catch(() => false)) {
      console.log('✅ 已检测到未到续期时间提示');
      return;
    }

    await page.waitForTimeout(500);
  }

  throw new Error('点击 Renew 后未找到确认弹窗或确认按钮，可能页面结构已变更');
}

async function clickActualRenewButton(page) {
  const candidateLocators = [
    page.locator('#renew-link-modal'),
    page.locator('#renew-modal a').filter({ hasText: /renew|confirm|yes/i }),
    page.locator('a[href*="/renew?id="]').filter({ hasText: /renew|confirm|yes/i }),
    page.locator('a[href*="../renew?id="]').filter({ hasText: /renew|confirm|yes/i }),
    page.locator('form[action*="/api/renew"] button[type="submit"]'),
    page.locator('form[action*="/api/renew"] input[type="submit"]'),
    page.locator('#renew-modal button').filter({ hasText: /confirm|renew|yes/i }),
    page.locator('[role="dialog"] button').filter({ hasText: /confirm|renew|yes/i }),
    page.getByRole('button', { name: /confirm|renew server|renew now|yes/i }),
  ];

  for (const locator of candidateLocators) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;

        const text = (await el.innerText().catch(() => '')).trim();
        console.log(`👉 尝试点击续期确认控件: "${text || '[表单提交按钮]'}"`);

        await Promise.allSettled([
          page.waitForURL(/success=RENEWED|err=/i, { timeout: 10000, waitUntil: 'commit' }),
          page.waitForLoadState('domcontentloaded', { timeout: 10000 }),
          el.click({ timeout: 5000 }),
        ]);

        return true;
      }
    } catch {}
  }

  const renewForm = page.locator('form[action*="/api/renew"]').first();
  if (await renewForm.isVisible().catch(() => false)) {
    console.log('👉 未找到可点击按钮，尝试直接提交续期表单');
    await Promise.allSettled([
      page.waitForURL(/success=RENEWED|err=/i, { timeout: 10000, waitUntil: 'commit' }),
      page.waitForLoadState('domcontentloaded', { timeout: 10000 }),
      renewForm.evaluate((form) => {
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      }),
    ]);
    return true;
  }

  return false;
}

async function waitForRenewResult(page, options = {}) {
  const {
    timeout = 20000,
    previousStatusText = '',
    previousRemainingDays = null,
  } = options;

  const successText = page.getByText(/Server Renewed Successfully|Renewed Successfully/i).first();
  const insufficientText = page.getByText(/cannot afford|not enough coins|insufficient/i).first();
  const normalizedPreviousStatusText = normalizeText(previousStatusText);

  const signal = await Promise.any([
    page.waitForURL(/success=RENEWED/i, { timeout, waitUntil: 'commit' }).then(() => 'success-url'),
    successText.waitFor({ state: 'visible', timeout }).then(() => 'success-text'),
    page.waitForURL(/err=CANNOTAFFORDRENEWAL/i, { timeout, waitUntil: 'commit' }).then(() => 'insufficient-url'),
    insufficientText.waitFor({ state: 'visible', timeout }).then(() => 'insufficient-text'),
    page.waitForFunction(
      ({ selector, previousText }) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const currentText = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return Boolean(currentText) && currentText !== previousText;
      },
      { selector: '#renewal-status-console', previousText: normalizedPreviousStatusText },
      { timeout }
    ).then(() => 'status-changed'),
  ]).catch(() => 'timeout');

  const finalUrl = page.url();
  const pageText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  const currentStatusText = await page.locator('#renewal-status-console')
    .innerText({ timeout: 2000 })
    .catch(() => null);
  const normalizedCurrentStatusText = normalizeText(currentStatusText);
  const currentRemainingDays = parseRemainingDays(currentStatusText);
  const statusLooksRenewed =
    signal === 'status-changed' &&
    typeof previousRemainingDays === 'number' &&
    typeof currentRemainingDays === 'number' &&
    currentRemainingDays > previousRemainingDays + 0.5;

  if (
    signal === 'success-url' ||
    signal === 'success-text' ||
    statusLooksRenewed ||
    /success=RENEWED/i.test(finalUrl) ||
    /server renewed successfully|renewed successfully/i.test(pageText)
  ) {
    return {
      status: 'success',
      signal,
      finalUrl,
      pageText,
      currentStatusText,
      currentRemainingDays,
      debugSummary: `signal=${signal}, url=${finalUrl}, previousStatus="${normalizedPreviousStatusText}", currentStatus="${normalizedCurrentStatusText}"`,
    };
  }

  if (
    signal === 'insufficient-url' ||
    signal === 'insufficient-text' ||
    /err=CANNOTAFFORDRENEWAL/i.test(finalUrl) ||
    /cannot afford|not enough coins|insufficient/i.test(pageText)
  ) {
    return {
      status: 'insufficient',
      signal,
      finalUrl,
      pageText,
      currentStatusText,
      currentRemainingDays,
      debugSummary: `signal=${signal}, url=${finalUrl}, pageTextMatched=insufficient`,
    };
  }

  if (/err=/i.test(finalUrl)) {
    return {
      status: 'error',
      signal,
      finalUrl,
      pageText,
      currentStatusText,
      currentRemainingDays,
      debugSummary: `signal=${signal}, url=${finalUrl}, currentStatus="${normalizedCurrentStatusText}"`,
    };
  }

  return {
    status: 'unknown',
    signal,
    finalUrl,
    pageText,
    currentStatusText,
    currentRemainingDays,
    debugSummary: `signal=${signal}, url=${finalUrl}, previousStatus="${normalizedPreviousStatusText}", currentStatus="${normalizedCurrentStatusText}"`,
  };
}

// ============== 主流程 ==============

test('FreezeHost 自动续期', async () => {
  if (!DISCORD_EMAIL || !DISCORD_PASSWORD) throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email,password');
  ensureDir(ART_DIR);

  let proxyConfig;
  if (process.env.GOST_PROXY) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 }, () => resolve());
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      proxyConfig = { server: process.env.GOST_PROXY };
      console.log('🛡️ 本地代理连通，使用 GOST 转发');
    } catch {
      console.log('⚠️ 本地代理不可达，降级为直连');
    }
  }

  console.log('🔧 启动浏览器...');
  const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    console.log('🔑 打开 FreezeHost 登录页...');
    await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
    await page.click('span.text-lg:has-text("Login with Discord")');

    console.log('⏳ 等待服务条款弹窗...');
    const confirmBtn = page.locator('button#confirm-login');
    await confirmBtn.waitFor({ state: 'visible' });
    await confirmBtn.click();

    await page.waitForURL(/discord\.com\/login/);
    console.log('✏️ 填写账号密码...');
    await page.fill('input[name="email"]', DISCORD_EMAIL);
    await page.fill('input[name="password"]', DISCORD_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);

    if (/discord\.com\/login/.test(page.url())) {
      let err = '账密错误或触发了 2FA / 验证码';
      try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
      throw new Error(`❌ Discord 登录失败: ${err}`);
    }

    console.log('⏳ 等待 OAuth 授权...');
    try {
      await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
      await handleOAuthPage(page);
      await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
    } catch {}

    try {
      await page.waitForURL(url => url.includes('/callback') || url.includes('/dashboard'), { timeout: 10000 });
    } catch {}
    if (page.url().includes('/callback')) await page.waitForURL(/free\.freezehost\.pro\/dashboard/);

    console.log('🔍 查找 Manage 按钮...');
    await page.waitForTimeout(3000);
    const serverUrl = await page.evaluate(() => document.querySelector('a[href*="server-console"]')?.href || null);
    if (!serverUrl) throw new Error('❌ 未找到 server-console 链接');

    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    console.log(`✅ 已跳转到 Server Console`);
    await page.waitForTimeout(3000);
    await closeReviewPopupIfPresent(page);

    // ======== 注入你的主流程逻辑 ========
    const renewalStatusText = await page.locator('#renewal-status-console')
      .innerText()
      .catch(() => null);

    if (!renewalStatusText) {
      throw new Error('❌ 未找到 #renewal-status-console，无法确认是否到续期时间');
    }

    console.log(`📋 续期状态：${renewalStatusText}`);

    const remainingDays = parseRemainingDays(renewalStatusText);
    if (remainingDays == null) {
      throw new Error(`❌ 无法解析续期状态文本：${renewalStatusText}`);
    }

    if (remainingDays > 7) {
      const msg = `⏰ 剩余 ${remainingDays.toFixed(2)} 天，未到续期时间（需 ≤7 天才续期）`;
      console.log(msg);
      await sendTG(msg, remainingDays);
      return;
    }

    console.log(`✅ 剩余 ${remainingDays.toFixed(2)} 天，进入续期检查...`);

    await openRenewalModal(page);

    if (await renewalModalSaysNotRenewable(page)) {
      const msg = '⏰ 当前提示未到续期时间';
      console.log(msg);
      await sendTG(msg, remainingDays);
      return;
    }

    console.log('🔍 尝试点击确认按钮...');
    const clicked = await clickActualRenewButton(page);
    if (!clicked) {
      throw new Error('⚠️ 已打开弹窗，但未找到 Confirm 续期确认按钮');
    }

    console.log('📤 已提交续期操作，等待结果...');

    const renewResult = await waitForRenewResult(page, {
      previousStatusText: renewalStatusText,
      previousRemainingDays: remainingDays,
    });

    console.log(`🧭 续期结果诊断: ${renewResult.debugSummary}`);

    if (renewResult.status === 'success') {
      console.log('🎉 续期成功！');
      const renewedStatusText = renewResult.currentStatusText || await page.locator('#renewal-status-console')
        .innerText({ timeout: 5000 })
        .catch(() => null);
      const renewedRemainingDays = parseRemainingDays(renewedStatusText) ?? renewResult.currentRemainingDays ?? remainingDays;
      await sendTG('✅ 续期成功！', renewedRemainingDays);
      return;
    }

    if (renewResult.status === 'insufficient') {
      console.log('⚠️ 余额不足，无法续期');
      await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币', remainingDays);
      return;
    }

    throw new Error(`❌ 未识别到续期结果（${renewResult.debugSummary}）`);

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
