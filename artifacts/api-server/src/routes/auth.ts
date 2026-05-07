import { Router, type IRouter } from "express";
import { chromium } from "playwright";
import { logger } from "../lib/logger";

const router: IRouter = Router();

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

    // Check for 2FA / checkpoint
    if (
      currentUrl.includes("checkpoint") ||
      currentUrl.includes("two_step") ||
      currentUrl.includes("2fac") ||
      pageContent.includes("mã xác nhận") ||
      pageContent.includes("verification code") ||
      pageContent.includes("two-factor")
    ) {
      res.status(403).json({
        error:
          "Tài khoản bật xác minh 2 bước (2FA). Hãy tắt 2FA tạm thời, hoặc dùng tài khoản khác không bật 2FA.",
      });
      return;
    }

    // Check for account checkpoint / suspicious login
    if (currentUrl.includes("checkpoint") || pageContent.includes("suspicious")) {
      res.status(403).json({
        error:
          "Facebook phát hiện đăng nhập đáng ngờ và yêu cầu xác minh danh tính. Hãy mở Facebook trên điện thoại để xác nhận rồi thử lại.",
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

export default router;
