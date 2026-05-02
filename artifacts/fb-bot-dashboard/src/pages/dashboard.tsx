import React, { useState, useEffect, useRef } from "react";
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
  CheckCircle2,
  XCircle
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

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: botStatus, isLoading: isStatusLoading } = useGetBotStatus(undefined, {
    query: { refetchInterval: 3000 }
  });

  const startBot = useStartBot();
  const stopBot = useStopBot();
  const updateSettings = useUpdateBotSettings();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  
  // Local state for auto-save
  const [prompt, setPrompt] = useState("");
  const promptInitialized = useRef(false);
  
  useEffect(() => {
    if (botStatus && !promptInitialized.current) {
      setPrompt(botStatus.systemPrompt || "");
      promptInitialized.current = true;
    }
  }, [botStatus]);

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    
    startBot.mutate({ data: { email, password } }, {
      onSuccess: () => {
        toast({ title: "Connecting to Facebook..." });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      },
      onError: (err) => {
        toast({ 
          title: "Failed to start", 
          description: err.error || "Unknown error occurred",
          variant: "destructive"
        });
      }
    });
  };

  const handleStop = () => {
    stopBot.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Bot stopped successfully" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  const handleToggleAutoReply = (checked: boolean) => {
    updateSettings.mutate({ data: { autoReplyEnabled: checked } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        toast({ title: checked ? "Auto-reply enabled" : "Auto-reply disabled" });
      }
    });
  };

  const handleSavePrompt = () => {
    updateSettings.mutate({ data: { systemPrompt: prompt } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        toast({ title: "System prompt updated" });
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
        </div>
      </div>

      {hasError && botStatus?.error && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>System Error</AlertTitle>
          <AlertDescription>{botStatus.error}</AlertDescription>
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
                Connection
              </CardTitle>
              <CardDescription>Link your Facebook account</CardDescription>
            </CardHeader>
            <CardContent>
              {isStopped || hasError ? (
                <form onSubmit={handleStart} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input 
                      id="email" 
                      type="email" 
                      placeholder="account@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="bg-background/50"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input 
                      id="password" 
                      type="password" 
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="bg-background/50"
                    />
                  </div>
                  <Button 
                    type="submit" 
                    className="w-full" 
                    disabled={startBot.isPending}
                  >
                    {startBot.isPending ? (
                      <><RefreshCcw className="w-4 h-4 mr-2 animate-spin" /> Starting...</>
                    ) : (
                      <><Play className="w-4 h-4 mr-2" /> Start Bot</>
                    )}
                  </Button>
                </form>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                  <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-2 relative">
                    {isConnecting && (
                      <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
                    )}
                    <Bot className={`w-8 h-8 ${isRunning ? 'text-emerald-500' : 'text-emerald-500/50'}`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg">Agent Active</h3>
                    <p className="text-sm text-muted-foreground">Connected to Facebook</p>
                  </div>
                  <Button 
                    variant="destructive" 
                    className="w-full mt-4 bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20"
                    onClick={handleStop}
                    disabled={stopBot.isPending}
                  >
                    {stopBot.isPending ? (
                      <><RefreshCcw className="w-4 h-4 mr-2 animate-spin" /> Stopping...</>
                    ) : (
                      <><Square className="w-4 h-4 mr-2 fill-current" /> Stop Agent</>
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
                <span className="text-2xl font-bold font-mono">
                  {botStatus?.messagesHandled || 0}
                </span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Replies</span>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-6 flex flex-col items-center justify-center text-center">
                <Clock className="w-6 h-6 text-primary mb-3" />
                <span className="text-lg font-bold font-mono">
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
                  <CardDescription>Configure how the AI responds to incoming messages</CardDescription>
                </div>
                <div className="flex items-center gap-2 bg-background/50 px-3 py-1.5 rounded-lg border border-border/50">
                  <Switch 
                    checked={botStatus?.autoReplyEnabled || false} 
                    onCheckedChange={handleToggleAutoReply}
                    disabled={!botStatus || updateSettings.isPending}
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
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="min-h-[280px] font-mono text-sm bg-background/50 resize-none leading-relaxed"
                    placeholder="You are a helpful customer service assistant..."
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/20 border-t border-border/50 px-6 py-4 flex justify-between items-center">
              <p className="text-xs text-muted-foreground">Changes apply immediately to new conversations.</p>
              <Button 
                onClick={handleSavePrompt} 
                disabled={updateSettings.isPending || prompt === botStatus?.systemPrompt}
              >
                Save Prompt
              </Button>
            </CardFooter>
          </Card>
        </div>

      </div>
    </div>
  );
}
