import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import { Zap } from "lucide-react";

/** Shown to any signed-in visitor who is not the owner. */
export default function NotYourChatbot() {
  const { clear } = useInternetIdentity();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 text-ink">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-brand-wash text-brand">
          <Zap className="size-6" />
        </div>
        <h1 className="font-display text-4xl tracking-[-0.04em] text-ink">
          This chatbot is <em>taken</em>.
        </h1>
        <p className="mt-4 text-base text-muted">
          Every copy of CaffeineChatBot belongs to one person, and this one
          already has its owner. Remix your own copy on the Caffeine App Market
          and it is yours in a minute.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a
            href="https://caffeine.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-11 items-center rounded-full bg-ink px-6 text-[15px] text-canvas transition hover:opacity-90 active:translate-y-px"
          >
            Get your own
          </a>
          <button
            type="button"
            onClick={() => clear()}
            className="flex h-11 items-center rounded-full border border-hairline bg-paper px-6 text-[15px] text-ink transition hover:bg-soft"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
