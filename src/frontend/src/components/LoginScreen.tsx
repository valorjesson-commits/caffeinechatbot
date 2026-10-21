import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import { Zap } from "lucide-react";
import { useEffect, useRef } from "react";

export default function LoginScreen() {
  const { login, isInitializing, isLoggingIn, loginStatus } =
    useInternetIdentity();

  // One-tap feel: start the Internet Identity flow the moment the screen
  // mounts. Browsers that block the popup fall back to the button below,
  // which stays visible either way.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (isInitializing || isLoggingIn || autoStarted.current) return;
    autoStarted.current = true;
    login();
  }, [isInitializing, isLoggingIn, login]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 text-ink">
      <div className="w-full max-w-md">
        <div className="mb-10 flex flex-col items-center text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-brand-wash text-brand">
            <Zap className="size-6" />
          </div>
          <h1 className="font-display text-5xl tracking-[-0.04em] text-ink">
            CaffeineChatBot
          </h1>
        </div>

        <div className="rounded-[20px] border border-hairline bg-paper p-8 shadow-card">
          <h2 className="text-xl font-medium text-ink">
            {isLoggingIn
              ? "Confirm in the Internet Identity window"
              : "Sign in to start chatting"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {loginStatus === "loginError"
              ? "The sign-in window did not open — your browser may have blocked it. Use the button below."
              : "One tap with your passkey. Your chats stay yours: this is a personal, single-owner chatbot."}
          </p>

          <button
            type="button"
            onClick={() => login()}
            disabled={isInitializing || isLoggingIn}
            className="mt-6 h-12 w-full rounded-full bg-brand px-6 text-[15px] text-white transition hover:bg-brand-hover active:translate-y-px disabled:opacity-50"
          >
            {isInitializing
              ? "Loading…"
              : isLoggingIn
                ? "Opening Internet Identity…"
                : "Sign in with Internet Identity"}
          </button>
        </div>

        <p className="mt-8 text-center text-xs text-muted">
          © {new Date().getFullYear()} CaffeineChatBot · Built with caffeine.ai
        </p>
      </div>
    </div>
  );
}
