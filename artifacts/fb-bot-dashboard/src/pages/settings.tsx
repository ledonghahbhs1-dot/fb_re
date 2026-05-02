import React, { useState } from "react";
import { 
  useSetIgnoreThread, 
  useClearConversation 
} from "@workspace/api-client-react";
import { ShieldBan, Trash2, Search, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function Settings() {
  const { toast } = useToast();
  
  const [ignoreThreadId, setIgnoreThreadId] = useState("");
  const [clearThreadId, setClearThreadId] = useState("");

  const setIgnore = useSetIgnoreThread();
  const clearConv = useClearConversation();

  const handleIgnore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ignoreThreadId) return;
    
    setIgnore.mutate({ data: { threadId: ignoreThreadId, ignore: true } }, {
      onSuccess: () => {
        toast({ title: "Thread Blocked", description: `Bot will no longer reply to ${ignoreThreadId}` });
        setIgnoreThreadId("");
      },
      onError: (err) => {
        toast({ title: "Error", description: err.error, variant: "destructive" });
      }
    });
  };

  const handleClear = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clearThreadId) return;
    
    clearConv.mutate({ data: { threadId: clearThreadId } }, {
      onSuccess: () => {
        toast({ title: "Memory Cleared", description: `Cleared AI context for ${clearThreadId}` });
        setClearThreadId("");
      },
      onError: (err) => {
        toast({ title: "Error", description: err.error, variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Advanced Settings</h1>
        <p className="text-muted-foreground mt-1">Manage thread blocks and agent memory.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldBan className="w-5 h-5 text-orange-500" />
              Block Threads
            </CardTitle>
            <CardDescription>Prevent the bot from replying to specific conversations</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert className="bg-orange-500/10 border-orange-500/20 text-orange-500 mb-4">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Find the Thread ID in the Messenger URL (e.g. facebook.com/messages/t/<strong>123456789</strong>)
              </AlertDescription>
            </Alert>
            
            <form onSubmit={handleIgnore} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Paste Thread ID..." 
                  value={ignoreThreadId}
                  onChange={(e) => setIgnoreThreadId(e.target.value)}
                  className="pl-9 bg-background/50 font-mono text-sm"
                />
              </div>
              <Button type="submit" variant="secondary" disabled={!ignoreThreadId || setIgnore.isPending}>
                Block
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-destructive" />
              Clear Memory
            </CardTitle>
            <CardDescription>Erase the AI's conversation history for a specific thread</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground mb-4">
              Useful if the bot gets stuck in a loop or needs to forget previous context.
            </p>
            
            <form onSubmit={handleClear} className="flex gap-2">
              <Input 
                placeholder="Paste Thread ID..." 
                value={clearThreadId}
                onChange={(e) => setClearThreadId(e.target.value)}
                className="bg-background/50 font-mono text-sm"
              />
              <Button type="submit" variant="destructive" disabled={!clearThreadId || clearConv.isPending}>
                Clear Context
              </Button>
            </form>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
