import { useState, useRef, useEffect } from "react";
import { Send, Trash2, Cookie, MessageSquare, Copy, Check, ChevronDown, ChevronUp, Settings, X, Zap, Eye, EyeOff, Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = BASE ? `${BASE}/api` : "/api";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatResponse {
  success: boolean;
  session_id: string;
  reply: string;
  model: string;
  cookies_loaded: number;
  cookie_keys: string[];
  history_length: number;
  error?: string;
}

export default function ChatPage() {
  const [cookies, setCookies] = useState("");
  const [prompt, setPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cookieKeys, setCookieKeys] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [showCookies, setShowCookies] = useState(true);
  const [showSystem, setShowSystem] = useState(false);
  const [showPython, setShowPython] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apiUrl, setApiUrl] = useState("");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  // Auto-cookie modal
  const [showAutoModal, setShowAutoModal] = useState(false);
  const [autoEmail, setAutoEmail] = useState("");
  const [autoPass, setAutoPass] = useState("");
  const [showAutoPass, setShowAutoPass] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const origin = window.location.origin;
    const base = BASE ? `${origin}${BASE}` : origin;
    setApiUrl(`${base}/api/chat`);
  }, []);

  async function sendMessage() {
    if (!prompt.trim() || loading) return;
    setError(null);
    const userMsg = prompt.trim();
    setPrompt("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setMessages((m) => [...m, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const body: Record<string, any> = { prompt: userMsg };
      if (sessionId) {
        body.session_id = sessionId;
      } else {
        if (cookies.trim()) body.cookies = cookies.trim();
        if (systemPrompt.trim()) body.system_prompt = systemPrompt.trim();
      }

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data: ChatResponse = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error ?? "Lỗi không xác định");
        setMessages((m) => m.slice(0, -1));
        return;
      }

      setSessionId(data.session_id);
      setCookieKeys(data.cookie_keys);
      setModel(data.model);
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  function resetSession() {
    if (sessionId) {
      fetch(`${API_BASE}/chat/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => {});
    }
    setSessionId(null);
    setMessages([]);
    setCookieKeys([]);
    setError(null);
    setModel("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function autoFetchCookies() {
    if (!autoEmail || !autoPass) return;
    setAutoLoading(true);
    setAutoError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/fb-cookies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: autoEmail, password: autoPass }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setAutoError(data.error ?? "Lỗi không xác định");
        return;
      }
      setCookies(data.cookie_string);
      setShowAutoModal(false);
      setAutoEmail("");
      setAutoPass("");
      setShowCookies(true);
    } catch (e: any) {
      setAutoError(e?.message ?? "Network error");
    } finally {
      setAutoLoading(false);
    }
  }

  async function copyPythonCode() {
    const code = getPythonCode();
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function getPythonCode() {
    return `import requests

API_URL = "${apiUrl}"

# ── Gửi tin nhắn với cookie ──────────────────────────────
cookies = "c_user=YOUR_C_USER; xs=YOUR_XS; datr=YOUR_DATR"

response = requests.post(API_URL, json={
    "cookies": cookies,
    "prompt": "Xin chào! Bạn là ai?",
    "system_prompt": "Bạn là trợ lý AI hữu ích.",  # tùy chọn
})

data = response.json()
print("Reply:", data["reply"])
print("Session ID:", data["session_id"])

# ── Tiếp tục hội thoại (dùng session_id) ─────────────────
session_id = data["session_id"]

response2 = requests.post(API_URL, json={
    "session_id": session_id,
    "prompt": "Hãy kể cho tôi nghe một câu chuyện vui.",
})
print("Reply 2:", response2.json()["reply"])

# ── Reset session ─────────────────────────────────────────
requests.post(API_URL.replace("/chat", "/chat/reset"), json={
    "session_id": session_id
})
print("Session đã được xóa.")
`;
  }

  const ConfigPanel = () => (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Cookies section */}
      <div className="border-b border-gray-800">
        <button
          onClick={() => setShowCookies((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-900 transition-colors text-sm font-medium"
        >
          <div className="flex items-center gap-2">
            <Cookie className="w-4 h-4 text-amber-400" />
            <span>Facebook Cookies</span>
            {cookieKeys.length > 0 && (
              <span className="text-xs bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded-full">
                {cookieKeys.length}
              </span>
            )}
          </div>
          {showCookies ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
        </button>

        {showCookies && (
          <div className="px-4 pb-4 space-y-2">
            <button
              onClick={() => { setShowAutoModal(true); setAutoError(null); }}
              disabled={!!sessionId}
              className="w-full flex items-center justify-center gap-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 text-xs font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Zap className="w-3.5 h-3.5" />
              Tự động lấy Cookie từ Facebook
            </button>
            <textarea
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              disabled={!!sessionId}
              placeholder="c_user=xxx; xs=yyy; datr=zzz; ..."
              rows={4}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none disabled:opacity-50"
            />
            {cookieKeys.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {cookieKeys.map((k) => (
                  <span key={k} className="text-xs bg-amber-900/30 text-amber-400 border border-amber-800/50 px-1.5 py-0.5 rounded">
                    {k}
                  </span>
                ))}
              </div>
            )}
            {sessionId && (
              <p className="text-xs text-gray-500">Cookie đã nạp. Reset để đổi cookie.</p>
            )}
          </div>
        )}
      </div>

      {/* System prompt */}
      <div className="border-b border-gray-800">
        <button
          onClick={() => setShowSystem((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-900 transition-colors text-sm font-medium"
        >
          <span className="text-gray-300">System Prompt</span>
          {showSystem ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
        </button>
        {showSystem && (
          <div className="px-4 pb-4">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={!!sessionId}
              placeholder="Bạn là trợ lý AI hữu ích..."
              rows={4}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none disabled:opacity-50"
            />
          </div>
        )}
      </div>

      {/* Session info */}
      {sessionId && (
        <div className="px-4 py-3 border-b border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Session ID</p>
          <p className="text-xs font-mono text-blue-400 break-all">{sessionId}</p>
        </div>
      )}

      {/* Python code */}
      <div className="flex-1 px-4 py-3">
        <button
          onClick={() => setShowPython((v) => !v)}
          className="w-full flex items-center justify-between mb-2 text-xs text-gray-500 font-medium hover:text-gray-300 transition-colors"
        >
          <span>Python Example</span>
          <div className="flex items-center gap-2">
            <span
              onClick={(e) => { e.stopPropagation(); copyPythonCode(); }}
              className="flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied!" : "Copy"}
            </span>
            {showPython ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </button>
        {showPython && (
          <pre className="text-xs font-mono text-gray-500 bg-gray-900 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
            {getPythonCode()}
          </pre>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-gray-800 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight">Cookie Chat API</h1>
            <p className="text-xs text-gray-500 truncate hidden sm:block">{apiUrl}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {model && (
            <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded-full hidden sm:inline">{model}</span>
          )}
          {sessionId && (
            <button
              onClick={resetSession}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 px-2 py-1.5 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Reset</span>
            </button>
          )}
          {/* Mobile config toggle */}
          <button
            onClick={() => setMobileDrawerOpen((v) => !v)}
            className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {mobileDrawerOpen ? <X className="w-4 h-4" /> : <Settings className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex w-72 border-r border-gray-800 flex-col overflow-hidden">
          <ConfigPanel />
        </aside>

        {/* Mobile drawer overlay */}
        {mobileDrawerOpen && (
          <div className="md:hidden absolute inset-0 z-40 flex flex-col" style={{ top: 57 }}>
            <div className="flex-1 bg-gray-950/95 backdrop-blur border-b border-gray-800 overflow-y-auto max-h-[70vh]">
              <ConfigPanel />
            </div>
            <div
              className="flex-1 bg-black/40"
              onClick={() => setMobileDrawerOpen(false)}
            />
          </div>
        )}

        {/* Main chat area */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
                <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center mb-4">
                  <MessageSquare className="w-6 h-6 text-gray-500" />
                </div>
                <h2 className="text-gray-400 font-medium mb-2">Sẵn sàng nhận tin nhắn</h2>
                <p className="text-sm text-gray-600 max-w-xs">
                  Nhập cookie Facebook, sau đó gõ câu hỏi bên dưới.
                  <span className="md:hidden"> Nhấn <Settings className="inline w-3.5 h-3.5 mx-0.5" /> để cấu hình.</span>
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-sm"
                      : "bg-gray-800 text-gray-200 rounded-bl-sm"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="flex justify-center">
                <div className="bg-red-900/30 border border-red-800 text-red-400 text-sm rounded-xl px-4 py-3 max-w-sm text-center">
                  {error}
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t border-gray-800 px-3 sm:px-6 py-3 flex-shrink-0">
            <div className="flex items-end gap-2 bg-gray-900 border border-gray-700 rounded-2xl px-3 py-2.5 focus-within:border-blue-600 transition-colors">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nhập prompt..."
                rows={1}
                className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 focus:outline-none resize-none min-h-[24px] max-h-32"
                style={{ overflow: "hidden" }}
                onInput={(e) => {
                  const t = e.target as HTMLTextAreaElement;
                  t.style.height = "auto";
                  t.style.height = Math.min(t.scrollHeight, 128) + "px";
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!prompt.trim() || loading}
                className="w-8 h-8 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-gray-700 mt-1.5 text-center truncate px-2">
              POST <code className="text-gray-600">{apiUrl}</code>
            </p>
          </div>
        </main>
      </div>

      <footer className="border-t border-gray-800 bg-gray-950 py-2.5 px-4 flex flex-wrap items-center justify-center gap-3 text-xs text-gray-500 flex-shrink-0">
        <span>Tạo bởi</span>
        <a href="https://facebook.com/wolfmodkk" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-400 transition-colors">facebook.com/wolfmodkk</a>
        <span className="text-gray-700">·</span>
        <a href="https://youtube.com/@cheatmod796" target="_blank" rel="noopener noreferrer" className="text-red-500 hover:text-red-400 transition-colors">youtube.com/@cheatmod796</a>
        <span className="text-gray-700">·</span>
        <a href="https://t.me/wolfmodyt" target="_blank" rel="noopener noreferrer" className="text-sky-500 hover:text-sky-400 transition-colors">t.me/wolfmodyt</a>
      </footer>

      {/* Auto-cookie modal */}
      {showAutoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center">
                  <Zap className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Tự động lấy Cookie</h3>
                  <p className="text-xs text-gray-500">Server đăng nhập Facebook và trích xuất cookie</p>
                </div>
              </div>
              <button
                onClick={() => { setShowAutoModal(false); setAutoError(null); }}
                className="w-7 h-7 rounded-lg hover:bg-gray-800 flex items-center justify-center text-gray-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Warning */}
            <div className="mx-5 mt-4 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2.5">
              <p className="text-xs text-amber-400 leading-relaxed">
                <strong>Lưu ý:</strong> Mật khẩu chỉ dùng để đăng nhập tạm thời, không lưu lại.
                Nếu tài khoản bật <strong>2FA</strong>, hãy tắt tạm thời trước khi dùng tính năng này.
              </p>
            </div>

            {/* Form */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Email / Số điện thoại Facebook</label>
                <input
                  type="email"
                  value={autoEmail}
                  onChange={(e) => setAutoEmail(e.target.value)}
                  placeholder="account@example.com"
                  disabled={autoLoading}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Mật khẩu</label>
                <div className="relative">
                  <input
                    type={showAutoPass ? "text" : "password"}
                    value={autoPass}
                    onChange={(e) => setAutoPass(e.target.value)}
                    placeholder="••••••••"
                    disabled={autoLoading}
                    onKeyDown={(e) => { if (e.key === "Enter") autoFetchCookies(); }}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 pr-10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAutoPass((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showAutoPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {autoError && (
                <div className="bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2.5 text-xs text-red-400 leading-relaxed">
                  {autoError}
                </div>
              )}

              {autoLoading && (
                <div className="flex items-center gap-2 text-xs text-blue-400 bg-blue-900/20 border border-blue-800/30 rounded-lg px-3 py-2.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                  <span>Đang đăng nhập Facebook và trích xuất cookie... (~15-30 giây)</span>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-5 pb-5 flex gap-2">
              <button
                onClick={() => { setShowAutoModal(false); setAutoError(null); }}
                disabled={autoLoading}
                className="flex-1 py-2.5 rounded-xl border border-gray-700 text-sm text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                onClick={autoFetchCookies}
                disabled={autoLoading || !autoEmail || !autoPass}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-sm text-white font-medium transition-colors flex items-center justify-center gap-2"
              >
                {autoLoading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Đang lấy...</>
                ) : (
                  <><Zap className="w-4 h-4" /> Lấy Cookie</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
