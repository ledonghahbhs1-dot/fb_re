import { Router, type IRouter } from "express";
import { chromium, type Page, type Browser, type BrowserContext } from "playwright";
import { logger } from "../lib/logger";
import { randomUUID } from "crypto";

const router: IRouter = Router();

// ── Pending 2FA sessions for /api/auth/fb-cookies flow ───────────────────────
interface Auth2FASession {
  page: Page;
  browser: Browser;
  ctx: BrowserContext;
  createdAt: number;
}
const pending2FASessions = new Map<string, Auth2FASession>();

// Clean up sessions older than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pending2FASessions.entries()) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      session.browser.close().catch(() => {});
      pending2FASessions.delete(id);
      logger.info({ session_id: id }, "Expired 2FA auth session cleaned up");
    }
  }
}, 60_000);

const CHROMIUM_PATH: string | undefined =
  process.env.CHROMIUM_PATH ??
  (process.env.REPL_ID
    ? "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome"
    : undefined);

/**
 * POST /api/auth/fb-cookies
 * Accepts { email, password } OR { identifier, password }
 * identifier can be: email, phone number, or Facebook numeric ID
 * Launches a headless browser, logs into Facebook, returns cookies as string.
 */
router.post("/auth/fb-cookies", async (req, res) => {
  const body = req.body as { email?: string; identifier?: string; password?: string };
  // Support both "email" (legacy) and "identifier" (new - accepts FB ID, phone, email)
  const identifier = body.identifier ?? body.email;
  const { password } = body;

  if (!identifier || !password) {
    res.status(400).json({ error: "Cần cung cấp email/SĐT/Facebook ID và password" });
    return;
  }

  // Detect if it's a Facebook numeric ID and use phone-style login
  const isFbId = /^\d{5,20}$/.test(identifier.trim());

  let browser;
  try {
    logger.info({ identifier: isFbId ? `[FB_ID]${identifier.slice(0,4)}***` : identifier }, "Starting Playwright FB login for cookie extraction");

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    });

    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      locale: "vi-VN",
      viewport: { width: 390, height: 844 },
    });

    const page = await ctx.newPage();

    // Go to Facebook mobile login
    await page.goto("https://m.facebook.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Fill email / phone / Facebook ID (m.facebook.com login accepts all three)
    const emailInput = page.locator('input[name="email"], input[type="email"], #m_login_email');
    await emailInput.waitFor({ timeout: 10000 });
    await emailInput.fill(identifier.trim());

    // Fill password
    const passInput = page.locator('input[name="pass"], input[type="password"]');
    await passInput.waitFor({ timeout: 10000 });
    await passInput.fill(password);

    // Submit — try multiple selectors, fallback to pressing Enter
    const submitted = await page.evaluate(() => {
      const selectors = [
        'button[name="login"]',
        'input[name="login"]',
        '[data-sigil="m_login_button"]',
        'button[type="submit"]',
        'input[type="submit"]',
        'form button',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) { el.click(); return sel; }
      }
      return null;
    });
    if (!submitted) {
      await passInput.press("Enter");
    }

    // Wait for redirect away from login page
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 20000 }).catch(() => {});

    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const pageContent = await page.content();

    // Check if still on login page (wrong credentials)
    if (currentUrl.includes("/login") || currentUrl.includes("login.php")) {
      const hasError =
        pageContent.includes("Mật khẩu") ||
        pageContent.includes("password") ||
        pageContent.includes("incorrect") ||
        pageContent.includes("không đúng") ||
        pageContent.includes("error");
      if (hasError) {
        res.status(401).json({ error: "Email/SĐT/Facebook ID hoặc mật khẩu không đúng. Vui lòng kiểm tra lại." });
        return;
      }
    }

    // Check for 2FA / checkpoint — keep session alive and return session_id
    if (
      currentUrl.includes("checkpoint") ||
      currentUrl.includes("two_step") ||
      currentUrl.includes("2fac") ||
      pageContent.includes("mã xác nhận") ||
      pageContent.includes("verification code") ||
      pageContent.includes("two-factor") ||
      pageContent.includes("approvals_code")
    ) {
      const session_id = randomUUID();
      pending2FASessions.set(session_id, { page, browser, ctx, createdAt: Date.now() });
      logger.info({ session_id }, "2FA required — session stored, waiting for OTP");
      // Don't close browser — it stays alive for the 2FA submit step
      browser = null as any;
      res.json({
        requires_2fa: true,
        session_id,
        message: "Tài khoản yêu cầu xác minh 2 bước. Vui lòng gọi /api/auth/2fa với session_id và mã OTP.",
      });
      return;
    }

    // Extract cookies
    const cookies = await ctx.cookies(["https://www.facebook.com", "https://m.facebook.com"]);

    const importantKeys = ["c_user", "xs", "datr", "fr", "sb", "wd", "locale"];
    const important = cookies.filter((c) => importantKeys.includes(c.name));
    const rest = cookies.filter((c) => !importantKeys.includes(c.name) && c.domain.includes("facebook"));

    const allCookies = [...important, ...rest];

    if (!allCookies.find((c) => c.name === "c_user")) {
      res.status(401).json({
        error: "Đăng nhập thất bại hoặc cookie c_user không tìm thấy. Kiểm tra lại email/mật khẩu.",
      });
      return;
    }

    const cookieString = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cookieKeys = allCookies.map((c) => c.name);

    logger.info({ cookieKeys }, "FB cookies extracted successfully");

    res.json({
      success: true,
      cookie_string: cookieString,
      cookie_keys: cookieKeys,
      message: `Lấy được ${allCookies.length} cookies thành công`,
    });
  } catch (err: any) {
    logger.error({ err: String(err) }, "Failed to extract FB cookies");
    res.status(500).json({
      error: "Không thể khởi động trình duyệt: " + (err.message ?? String(err)),
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

/**
 * POST /api/auth/2fa
 * Submit OTP code for a pending 2FA session from /api/auth/fb-cookies.
 * Body: { session_id, code }
 * Returns the same cookie response as /api/auth/fb-cookies on success.
 */
router.post("/auth/2fa", async (req, res) => {
  const { session_id, code } = req.body as { session_id?: string; code?: string };
  if (!session_id || !code?.trim()) {
    res.status(400).json({ error: "Cần cung cấp session_id và mã xác minh (code)" });
    return;
  }

  const session = pending2FASessions.get(session_id);
  if (!session) {
    res.status(404).json({ error: "Phiên 2FA không tồn tại hoặc đã hết hạn. Vui lòng đăng nhập lại." });
    return;
  }

  const { page, browser, ctx } = session;

  try {
    logger.info({ session_id }, "Submitting 2FA OTP for auth session");

    const codeInput = page.locator([
      'input[name="approvals_code"]',
      'input[name="otp"]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[name="code"]',
    ].join(", "));

    await codeInput.waitFor({ timeout: 10000 });
    await codeInput.fill(code.trim());

    const submitDone = await page.evaluate(() => {
      const selectors = [
        "#checkpointSubmitButton",
        'button[name="submit[Continue]"]',
        'button[type="submit"]',
        'input[type="submit"]',
        "form button",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) { el.click(); return sel; }
      }
      return null;
    });
    if (!submitDone) await codeInput.press("Enter");

    await page.waitForURL(
      (url) => !url.toString().includes("checkpoint") && !url.toString().includes("two_step"),
      { timeout: 20000 }
    ).catch(() => {});

    await page.waitForTimeout(2000);

    const postUrl = page.url();
    if (postUrl.includes("checkpoint") || postUrl.includes("two_step") || postUrl.includes("/login")) {
      res.status(401).json({ error: "Mã xác minh không đúng hoặc đã hết hạn. Vui lòng thử lại." });
      return;
    }

    // Extract cookies
    const cookies = await ctx.cookies(["https://www.facebook.com", "https://m.facebook.com"]);
    const importantKeys = ["c_user", "xs", "datr", "fr", "sb", "wd", "locale"];
    const important = cookies.filter((c) => importantKeys.includes(c.name));
    const rest = cookies.filter((c) => !importantKeys.includes(c.name) && c.domain.includes("facebook"));
    const allCookies = [...important, ...rest];

    if (!allCookies.find((c) => c.name === "c_user")) {
      res.status(401).json({ error: "Xác minh thành công nhưng không tìm thấy cookie. Vui lòng thử lại." });
      return;
    }

    const cookieString = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cookieKeys = allCookies.map((c) => c.name);

    logger.info({ session_id, cookieKeys }, "2FA auth — cookies extracted successfully");
    pending2FASessions.delete(session_id);

    res.json({
      success: true,
      cookie_string: cookieString,
      cookie_keys: cookieKeys,
      message: `Xác minh 2FA thành công. Lấy được ${allCookies.length} cookies.`,
    });
  } catch (err: any) {
    logger.error({ err: String(err), session_id }, "2FA auth submission failed");
    res.status(500).json({ error: "Xác minh 2FA thất bại: " + (err.message ?? String(err)) });
  } finally {
    pending2FASessions.delete(session_id);
    await browser.close().catch(() => {});
  }
});

export default router;
