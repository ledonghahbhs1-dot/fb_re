import React, { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Bot, Settings, MessageSquare, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  // Force dark mode
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  const navItems = [
    { href: "/", label: "Dashboard", icon: Bot },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="flex min-h-screen w-full bg-background overflow-hidden selection:bg-primary/30">
      <aside className="w-64 border-r border-border/50 bg-card/30 flex flex-col backdrop-blur-xl">
        <div className="h-16 flex items-center px-6 border-b border-border/50 gap-3">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary">
            <MessageSquare className="w-5 h-5" />
          </div>
          <span className="font-semibold tracking-tight text-foreground/90">Bot Control</span>
        </div>
        
        <nav className="flex-1 py-6 px-3 flex flex-col gap-1">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200",
                  isActive 
                    ? "bg-primary/10 text-primary" 
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground/70")} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        
        <div className="p-4 border-t border-border/50">
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted/30 border border-border/30">
            <ShieldAlert className="w-4 h-4 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="text-xs font-medium text-foreground/80">Protected</span>
              <span className="text-[10px] text-muted-foreground">Admin Access Only</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-y-auto">
        <div className="flex-1 p-8 max-w-6xl w-full mx-auto">
          {children}
        </div>
        <footer className="border-t border-border/50 py-2.5 px-6 flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-muted-foreground/40 mr-1">Tạo bởi</span>
          <a href="https://facebook.com/wolfmodkk" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 bg-blue-600/10 hover:bg-blue-600/20 border border-blue-600/20 text-blue-400/70 hover:text-blue-400 text-xs px-2.5 py-1 rounded-full transition-colors">
            <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            wolfmodkk
          </a>
          <a href="https://youtube.com/@cheatmod796" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 bg-red-600/10 hover:bg-red-600/20 border border-red-600/20 text-red-400/70 hover:text-red-400 text-xs px-2.5 py-1 rounded-full transition-colors">
            <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
            cheatmod796
          </a>
          <a href="https://t.me/wolfmodyt" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 text-sky-400/70 hover:text-sky-400 text-xs px-2.5 py-1 rounded-full transition-colors">
            <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
            wolfmodyt
          </a>
        </footer>
      </main>
    </div>
  );
}
