import { useState, useRef, useEffect } from "react";
import { Send, Trash2, Cookie, MessageSquare, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";

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
  const [copied, setCopied] = useState(false);
  const [apiUrl, setApiUrl] = useState("");
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

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Cookie Chat API</h1>
            <p className="text-xs text-gray-500">{apiUrl}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {model && (
            <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded-full">{model}</span>
          )}
          {sessionId && (
            <button
              onClick={resetSession}
              className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Reset
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — config */}
        <aside className="w-72 border-r border-gray-800 flex flex-col overflow-y-auto">
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
                <textarea
                  value={cookies}
                  onChange={(e) => setCookies(e.target.value)}
                  disabled={!!sessionId}
                  placeholder="c_user=xxx; xs=yyy; datr=zzz; ..."
                  rows={5}
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
                  <p className="text-xs text-gray-500">Cookie đã được nạp. Reset để thay cookie mới.</p>
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
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500 font-medium">Python Example</p>
              <button
                onClick={copyPythonCode}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre className="text-xs font-mono text-gray-500 bg-gray-900 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
              {getPythonCode()}
            </pre>
          </div>
        </aside>

        {/* Main chat area */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-20">
                <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center mb-4">
                  <MessageSquare className="w-6 h-6 text-gray-500" />
                </div>
                <h2 className="text-gray-400 font-medium mb-2">Sẵn sàng nhận tin nhắn</h2>
                <p className="text-sm text-gray-600 max-w-sm">
                  Nhập cookie Facebook vào thanh bên, sau đó gõ câu hỏi bên dưới.
                  Bạn cũng có thể gọi API này trực tiếp từ Python.
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
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
                <div className="bg-red-900/30 border border-red-800 text-red-400 text-sm rounded-xl px-4 py-3 max-w-md text-center">
                  {error}
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t border-gray-800 px-6 py-4">
            <div className="flex items-end gap-3 bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 focus-within:border-blue-600 transition-colors">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nhập prompt... (Enter để gửi, Shift+Enter để xuống dòng)"
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
            <p className="text-xs text-gray-600 mt-2 text-center">
              POST <code className="text-gray-500">{apiUrl}</code>
            </p>
          </div>
        </main>
      </div>

      <footer className="border-t border-gray-800 bg-gray-950 py-3 px-6 flex flex-wrap items-center justify-center gap-4 text-xs text-gray-500">
        <span>Tạo bởi</span>
        <a href="https://facebook.com/wolfmodkk" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-400 transition-colors">facebook.com/wolfmodkk</a>
        <span className="text-gray-700">·</span>
        <a href="https://youtube.com/@cheatmod796" target="_blank" rel="noopener noreferrer" className="text-red-500 hover:text-red-400 transition-colors">youtube.com/@cheatmod796</a>
        <span className="text-gray-700">·</span>
        <a href="https://t.me/wolfmodyt" target="_blank" rel="noopener noreferrer" className="text-sky-500 hover:text-sky-400 transition-colors">t.me/wolfmodyt</a>
      </footer>
    </div>
  );
}
