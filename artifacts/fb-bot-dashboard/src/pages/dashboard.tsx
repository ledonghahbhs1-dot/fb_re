import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  useGetBotStatus, 
  getGetBotStatusQueryKey,
  useStartBot,
  useStopBot,
  useUpdateBotSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Bot, 
  Play, 
  Square, 
  Activity, 
  AlertCircle,
  MessageCircle,
  Clock,
  Settings2,
  Lock,
  RefreshCcw,
  KeyRound,
  Cookie,
  Info,
  ChevronDown,
  ChevronUp,
  Terminal,
  Trash2,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

type LoginTab = "appstate" | "credentials";

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: botStatus, isLoading: isStatusLoading } = useGetBotStatus(undefined, {
    query: { refetchInterval: 3000 }
  });

  const startBot = useStartBot();
  const stopBot = useStopBot();
  const updateSettings = useUpdateBotSettings();

  const [loginTab, setLoginTab] = useState<LoginTab>("appstate");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [appState, setAppState] = useState("");
  const [showGuide, setShowGuide] = useState(false);
  const [twoFACode, setTwoFACode] = useState("");
  const [is2FASubmitting, setIs2FASubmitting] = useState(false);
  
  const [prompt, setPrompt] = useState("");
  const promptInitialized = useRef(false);

  // Live logs
  interface LogEntry { ts: number; level: string; msg: string; data?: Record<string, any>; }
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastLogTs = useRef<number>(Date.now());

  const fetchLogs = useCallback(async () => {
    try {
      const url = lastLogTs.current
        ? `/api/bot/logs?since=${lastLogTs.current}`
        : `/api/bot/logs`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const newEntries: LogEntry[] = json.logs ?? [];
      if (newEntries.length > 0) {
        lastLogTs.current = newEntries[newEntries.length - 1].ts;
        setLogs((prev) => {
          const combined = [...prev, ...newEntries];
          return combined.slice(-300);
        });
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchLogs();
    const id = setInterval(fetchLogs, 1500);
    return () => clearInterval(id);
  }, [fetchLogs]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (botStatus && !promptInitialized.current) {
      setPrompt(botStatus.systemPrompt || "");
      promptInitialized.current = true;
    }
  }, [botStatus]);

  const handleStartCredentials = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier || !password) return;
    startBot.mutate({ data: { identifier, password } as any }, {
      onSuccess: (data: any) => {
        if (data?.requires_2fa) {
          toast({ title: "Cần xác minh 2FA", description: "Vui lòng nhập mã OTP từ ứng dụng xác thực hoặc SMS." });
        } else {
          toast({ title: "Đang kết nối Facebook..." });
        }
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error || err?.message || "Không thể đăng nhập";
        toast({ title: "Lỗi đăng nhập", description: msg, variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  const handle2FASubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFACode.trim()) return;
    setIs2FASubmitting(true);
    try {
      const res = await fetch("/api/bot/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: twoFACode.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast({ title: "Xác minh thành công!", description: "Bot đang kết nối..." });
        setTwoFACode("");
      } else {
        toast({ title: "Lỗi xác minh", description: data.error || "Mã không đúng. Vui lòng thử lại.", variant: "destructive" });
      }
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    } catch {
      toast({ title: "Lỗi kết nối", description: "Không thể gửi mã xác minh.", variant: "destructive" });
    } finally {
      setIs2FASubmitting(false);
    }
  };

  const handleStartAppState = (e: React.FormEvent) => {
    e.preventDefault();
    if (!appState.trim()) return;
    startBot.mutate({ data: { appState: appState.trim() } as any }, {
      onSuccess: () => {
        toast({ title: "Đang kết nối Facebook qua AppState..." });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error || err?.message || "AppState không hợp lệ";
        toast({ title: "Lỗi kết nối", description: msg, variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  const handleStop = () => {
    stopBot.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Bot đã dừng" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  const handleToggleAutoReply = (checked: boolean) => {
    updateSettings.mutate({ data: { autoReplyEnabled: checked } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        toast({ title: checked ? "Bật tự động trả lời" : "Tắt tự động trả lời" });
      }
    });
  };

  const handleSavePrompt = () => {
    updateSettings.mutate({ data: { systemPrompt: prompt } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        toast({ title: "Đã lưu system prompt" });
      }
    });
  };

  if (isStatusLoading && !botStatus) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-[200px]" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[200px] md:col-span-2" />
        </div>
      </div>
    );
  }

  const isRunning = botStatus?.status === "running";
  const isConnecting = botStatus?.status === "connecting";
  const isStopped = botStatus?.status === "stopped";
  const hasError = botStatus?.status === "error";
  const isWaiting2FA = botStatus?.status === "waiting_2fa";

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Status</h1>
          <p className="text-muted-foreground mt-1">Monitor and control your AI auto-reply agent.</p>
        </div>
        <div className="flex items-center gap-3 bg-card border border-border/50 px-4 py-2 rounded-full shadow-sm">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Status:</span>
          {isRunning && <Badge className="bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 border-emerald-500/20">Running</Badge>}
          {isConnecting && <Badge className="bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 border-amber-500/20 animate-pulse">Connecting</Badge>}
          {isStopped && <Badge variant="secondary">Offline</Badge>}
          {hasError && <Badge variant="destructive">Error</Badge>}
          {isWaiting2FA && <Badge className="bg-violet-500/15 text-violet-500 hover:bg-violet-500/25 border-violet-500/20 animate-pulse">Chờ 2FA</Badge>}
        </div>
      </div>

      {hasError && botStatus?.error && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Lỗi kết nối</AlertTitle>
          <AlertDescription className="mt-1">
            <span className="font-mono text-xs block mb-2">{botStatus.error}</span>
            <span className="text-xs opacity-80">
              Gợi ý: Facebook thường chặn đăng nhập từ IP mới. Hãy thử dùng <strong>App State (cookies)</strong> thay vì email/password.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* LEFT COLUMN: Controls */}
        <div className="space-y-6">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent pointer-events-none" />
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="w-5 h-5 text-primary" />
                Kết nối Facebook
              </CardTitle>
              <CardDescription>
                {isWaiting2FA ? "Xác minh 2 bước" : "Chọn phương thức đăng nhập"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isWaiting2FA ? (
                <form onSubmit={handle2FASubmit} className="space-y-4">
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-violet-500/10 border border-violet-500/20">
                    <ShieldCheck className="w-5 h-5 text-violet-400 mt-0.5 flex-shrink-0" />
                    <div className="text-sm">
                      <p className="font-medium text-violet-300">Cần xác minh 2 bước</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Facebook yêu cầu mã OTP. Mở ứng dụng xác thực (Authenticator) hoặc xem SMS để lấy mã 6 chữ số.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="twofa-code">Mã xác minh (OTP)</Label>
                    <Input
                      id="twofa-code"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={8}
                      placeholder="Ví dụ: 123456"
                      value={twoFACode}
                      onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, ""))}
                      className="text-center text-lg tracking-widest font-mono"
                      autoFocus
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!twoFACode.trim() || is2FASubmitting}
                  >
                    {is2FASubmitting ? (
                      <RefreshCcw className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldCheck className="w-4 h-4 mr-2" />
                    )}
                    {is2FASubmitting ? "Đang xác minh..." : "Xác nhận mã OTP"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full text-xs text-muted-foreground"
                    onClick={() => {
                      fetch("/api/bot/stop", { method: "POST" }).then(() => {
                        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
                      });
                    }}
                  >
                    Hủy và đăng nhập lại
                  </Button>
                </form>
              ) : isStopped || hasError ? (
                <div className="w-full">
                  {/* Custom tab buttons */}
                  <div className="flex rounded-lg bg-background/60 border border-border/40 p-1 mb-4 gap-1">
                    <button
                      type="button"
                      onClick={() => setLoginTab("appstate")}
                      data-testid="tab-appstate"
                      className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 px-2 rounded-md font-medium transition-all ${
                        loginTab === "appstate"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Cookie className="w-3.5 h-3.5" />
                      App State
                    </button>
                    <button
                      type="button"
                      onClick={() => setLoginTab("credentials")}
                      data-testid="tab-credentials"
                      className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 px-2 rounded-md font-medium transition-all ${
                        loginTab === "credentials"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      Email/Pass
                    </button>
                  </div>

                  {/* APP STATE PANEL */}
                  {loginTab === "appstate" && (
                    <form onSubmit={handleStartAppState} className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="appstate-input">App State (JSON)</Label>
                          <button
                            type="button"
                            onClick={() => setShowGuide(!showGuide)}
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <Info className="w-3 h-3" />
                            Cách lấy?
                            {showGuide ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        </div>

                        {showGuide && (
                          <div className="bg-muted/40 border border-border/50 rounded-md p-3 text-xs space-y-3 text-muted-foreground">
                            <div>
                              <p className="font-semibold text-foreground mb-1.5">Cách 1 — Dùng extension (dễ nhất):</p>
                              <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                                <li>Đăng nhập <strong>facebook.com</strong> trên Chrome</li>
                                <li>Cài <strong>"c3c-ufc-appstate"</strong> từ Chrome Web Store</li>
                                <li>Nhấn icon extension → <strong>"Get AppState"</strong> → Copy JSON</li>
                                <li>Paste vào ô bên dưới</li>
                              </ol>
                            </div>
                            <div className="border-t border-border/30 pt-2">
                              <p className="font-semibold text-foreground mb-1.5">Cách 2 — Copy cookie thủ công từ DevTools:</p>
                              <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                                <li>Vào <strong>facebook.com</strong>, nhấn <strong>F12</strong> → tab <strong>Application</strong></li>
                                <li>Chọn <strong>Cookies → https://www.facebook.com</strong></li>
                                <li>Tìm cookie <strong>c_user</strong>, <strong>xs</strong>, <strong>datr</strong>, <strong>fr</strong></li>
                                <li>Copy theo định dạng: <code className="bg-background/60 px-1 rounded">c_user=123; xs=abc; datr=xyz; fr=def</code></li>
                                <li>Paste vào ô bên dưới (app sẽ tự chuyển đổi)</li>
                              </ol>
                            </div>
                            <p className="text-amber-400/80 border-t border-border/30 pt-2">
                              Bắt buộc phải có cookie <strong>c_user</strong> và <strong>xs</strong>. Nên copy thêm <strong>datr</strong>, <strong>fr</strong>, <strong>sb</strong>.
                            </p>
                          </div>
                        )}

                        <Textarea
                          id="appstate-input"
                          data-testid="input-appstate"
                          placeholder={"Dán JSON array hoặc cookie string vào đây...\nVí dụ: c_user=123456; xs=abc:def; datr=xyz; fr=..."}
                          value={appState}
                          onChange={(e) => setAppState(e.target.value)}
                          required
                          className="font-mono text-xs min-h-[120px] bg-background/50 resize-none"
                        />
                        <p className="text-xs text-muted-foreground">
                          Chấp nhận: JSON array <code className="bg-muted px-1 rounded">[&#123;...&#125;]</code> hoặc cookie string <code className="bg-muted px-1 rounded">c_user=xxx; xs=xxx</code>
                        </p>
                      </div>
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={startBot.isPending || !appState.trim()}
                        data-testid="button-start-appstate"
                      >
                        {startBot.isPending ? (
                          <><RefreshCcw className="w-4 h-4 mr-2 animate-spin" /> Đang kết nối...</>
                        ) : (
                          <><Play className="w-4 h-4 mr-2" /> Khởi động Bot</>
                        )}
                      </Button>
                    </form>
                  )}

                  {/* CREDENTIALS PANEL */}
                  {loginTab === "credentials" && (
                    <form onSubmit={handleStartCredentials} className="space-y-3">
                      {/* Direct connect button — opens Facebook login popup */}
                      <button
                        type="button"
                        onClick={() => {
                          const w = 600, h = 700;
                          const left = Math.max(0, (window.screen.width - w) / 2);
                          const top = Math.max(0, (window.screen.height - h) / 2);
                          window.open(
                            "https://www.facebook.com/login",
                            "fb_login",
                            `width=${w},height=${h},top=${top},left=${left},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`
                          );
                        }}
                        className="w-full flex items-center justify-center gap-2 bg-[#1877F2]/15 hover:bg-[#1877F2]/25 border border-[#1877F2]/30 text-blue-400 text-xs font-medium py-2.5 rounded-lg transition-all hover:scale-[1.01] cursor-pointer"
                      >
                        <svg className="w-3.5 h-3.5 fill-current flex-shrink-0" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                        Mở cửa sổ đăng nhập Facebook
                        <ExternalLink className="w-3 h-3 opacity-60" />
                      </button>
                      <p className="text-[10px] text-muted-foreground/50 text-center -mt-1">
                        Đăng nhập Facebook trong cửa sổ popup → sau đó dùng App State để lấy cookie
                      </p>

                      <div className="flex items-center gap-2">
                        <div className="flex-1 border-t border-border/40" />
                        <span className="text-[10px] text-muted-foreground/50 font-medium">hoặc nhập thủ công</span>
                        <div className="flex-1 border-t border-border/40" />
                      </div>

                      <Alert className="bg-amber-500/10 border-amber-500/30 text-amber-400 py-2 px-3">
                        <AlertCircle className="h-3.5 w-3.5" />
                        <AlertDescription className="text-xs ml-1">
                          Facebook thường chặn IP lạ. Nếu bị lỗi, hãy dùng <strong>App State</strong>.
                        </AlertDescription>
                      </Alert>
                      <div className="space-y-2">
                        <Label htmlFor="identifier">Email / ID / SĐT</Label>
                        <Input
                          id="identifier"
                          type="text"
                          placeholder="email, số điện thoại hoặc Facebook ID"
                          value={identifier}
                          onChange={(e) => setIdentifier(e.target.value)}
                          required
                          className="bg-background/50"
                          data-testid="input-email"
                        />
                        <p className="text-[10px] text-muted-foreground/60">Hỗ trợ: email, SĐT, hoặc Facebook ID (dạng số)</p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="password">Mật khẩu</Label>
                        <Input
                          id="password"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          className="bg-background/50"
                          data-testid="input-password"
                        />
                      </div>
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={startBot.isPending}
                        data-testid="button-start-credentials"
                      >
                        {startBot.isPending ? (
                          <><RefreshCcw className="w-4 h-4 mr-2 animate-spin" /> Đang kết nối...</>
                        ) : (
                          <><Play className="w-4 h-4 mr-2" /> Khởi động Bot</>
                        )}
                      </Button>
                    </form>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                  <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-2 relative">
                    {isConnecting && (
                      <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
                    )}
                    <Bot className={`w-8 h-8 ${isRunning ? 'text-emerald-500' : 'text-emerald-500/50'}`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg">{isConnecting ? "Đang kết nối..." : "Bot đang hoạt động"}</h3>
                    <p className="text-sm text-muted-foreground">Đã kết nối Facebook Messenger</p>
                  </div>
                  <Button
                    variant="destructive"
                    className="w-full mt-4 bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20"
                    onClick={handleStop}
                    disabled={stopBot.isPending}
                    data-testid="button-stop"
                  >
                    {stopBot.isPending ? (
                      <><RefreshCcw className="w-4 h-4 mr-2 animate-spin" /> Đang dừng...</>
                    ) : (
                      <><Square className="w-4 h-4 mr-2 fill-current" /> Dừng Bot</>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-4">
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-6 flex flex-col items-center justify-center text-center">
                <MessageCircle className="w-6 h-6 text-primary mb-3" />
                <span className="text-2xl font-bold font-mono" data-testid="text-messages-handled">
                  {botStatus?.messagesHandled || 0}
                </span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Replies</span>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-6 flex flex-col items-center justify-center text-center">
                <Clock className="w-6 h-6 text-primary mb-3" />
                <span className="text-lg font-bold font-mono" data-testid="text-uptime">
                  {botStatus?.startedAt ? formatDistanceToNow(new Date(botStatus.startedAt)) : "0m"}
                </span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Uptime</span>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* RIGHT COLUMN: Configuration */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Settings2 className="w-5 h-5 text-primary" />
                    Agent Behavior
                  </CardTitle>
                  <CardDescription>Cấu hình cách AI trả lời tin nhắn</CardDescription>
                </div>
                <div className="flex items-center gap-2 bg-background/50 px-3 py-1.5 rounded-lg border border-border/50">
                  <Switch
                    checked={botStatus?.autoReplyEnabled || false}
                    onCheckedChange={handleToggleAutoReply}
                    disabled={!botStatus || updateSettings.isPending}
                    data-testid="switch-autoreply"
                  />
                  <Label className="text-sm cursor-pointer select-none font-medium">
                    {botStatus?.autoReplyEnabled ? 'Auto-reply ON' : 'Auto-reply OFF'}
                  </Label>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="prompt">System Prompt</Label>
                    <span className="text-xs text-muted-foreground">Claude Model Instructions</span>
                  </div>
                  <Textarea
                    id="prompt"
                    data-testid="textarea-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="min-h-[280px] font-mono text-sm bg-background/50 resize-none leading-relaxed"
                    placeholder="You are a helpful assistant..."
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/20 border-t border-border/50 px-6 py-4 flex justify-between items-center">
              <p className="text-xs text-muted-foreground">Thay đổi áp dụng ngay cho các cuộc trò chuyện mới.</p>
              <Button
                onClick={handleSavePrompt}
                disabled={updateSettings.isPending || prompt === botStatus?.systemPrompt}
                data-testid="button-save-prompt"
              >
                Lưu Prompt
              </Button>
            </CardFooter>
          </Card>
        </div>

      </div>

      {/* Live Log Viewer */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Terminal className="w-4 h-4 text-primary" />
              Live Logs
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setLogs([]); lastLogTs.current = Date.now(); }}
              className="h-7 px-2 text-xs text-muted-foreground"
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Xóa
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="h-48 overflow-y-auto overscroll-y-contain bg-black/80 font-mono text-xs px-3 py-2 space-y-0.5" style={{ touchAction: "pan-y" }}>
            {logs.length === 0 ? (
              <div className="text-muted-foreground/50 pt-2">
                Khởi động bot để xem logs...
              </div>
            ) : (
              logs.map((entry, i) => {
                const time = new Date(entry.ts).toLocaleTimeString("vi-VN", { hour12: false });
                const levelColor =
                  entry.level === "error" ? "text-red-400" :
                  entry.level === "warn"  ? "text-yellow-400" :
                  "text-green-400";
                const dataStr = entry.data && Object.keys(entry.data).length > 0
                  ? " " + JSON.stringify(entry.data)
                  : "";
                return (
                  <div key={i} className="flex gap-2 leading-5">
                    <span className="text-muted-foreground/60 shrink-0">{time}</span>
                    <span className={`shrink-0 uppercase text-[10px] font-bold ${levelColor}`}>
                      {entry.level.slice(0, 4)}
                    </span>
                    <span className="text-gray-200 break-all">
                      {entry.msg}
                      <span className="text-muted-foreground/70">{dataStr}</span>
                    </span>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
