import app from "./app";
import { logger } from "./lib/logger";
import { startBot, canAutoRestart } from "./bot/facebook";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Parse cookie string or JSON array into AppState format for Playwright injection.
// Accepts: "c_user=xxx; xs=yyy; ..." OR JSON array "[{key,value,...}]"
function parseFbCookies(raw: string): any[] | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch {
      return null;
    }
  }
  if (trimmed.includes("=")) {
    const cookies = trimmed
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf("=");
        if (eq === -1) return null;
        return {
          key: p.slice(0, eq).trim(),
          value: p.slice(eq + 1).trim(),
          domain: ".facebook.com",
          path: "/",
          hostOnly: false,
          creation: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
        };
      })
      .filter(Boolean);
    return cookies.length > 0 ? cookies : null;
  }
  return null;
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // ── Priority 1: FB_COOKIES env var (Railway / explicit config) ──────────────
  const fbCookiesRaw = process.env["FB_COOKIES"];
  if (fbCookiesRaw) {
    logger.info("FB_COOKIES env var detected — auto-starting bot");
    const appState = parseFbCookies(fbCookiesRaw);
    if (!appState) {
      logger.error("FB_COOKIES format invalid — expected cookie string or JSON array. Bot NOT started.");
    } else {
      try {
        await startBot({ type: "appstate", appState });
        logger.info("Bot auto-started from FB_COOKIES ✓");
      } catch (startErr: any) {
        logger.error({ err: startErr?.message }, "Auto-start from FB_COOKIES failed");
      }
    }
    return;
  }

  // ── Priority 2: Saved browser state from previous session ────────────────
  // If user started the bot before and didn't manually stop it, auto-restart.
  if (canAutoRestart()) {
    logger.info("Saved session detected — auto-restarting bot from previous session");
    try {
      // Pass empty appState — startBot will use saved browser-state.json cookies
      await startBot({ type: "appstate", appState: [] });
      logger.info("Bot auto-restarted from saved session ✓");
    } catch (startErr: any) {
      logger.warn({ err: startErr?.message }, "Auto-restart from saved session failed — manual login needed");
    }
  }
});
