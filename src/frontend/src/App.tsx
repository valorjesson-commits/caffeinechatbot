import ChatView from "@/components/ChatView";
import LoginScreen from "@/components/LoginScreen";
import NotYourChatbot from "@/components/NotYourChatbot";
import { devCredentials } from "@/lib/inference";
import { useActor, useInternetIdentity } from "@caffeineai/core-infrastructure";
import { useQuery } from "@tanstack/react-query";
import { UserRole, createActor } from "./backend";

/** Single-user gate: the first person to sign in owns this chatbot; anyone
 * else gets pointed at remixing their own copy. Ownership is decided by the
 * backend during sign-in, so this only asks which side we are on. */
function OwnerGate() {
  const { actor, isFetching } = useActor(createActor);
  const role = useQuery({
    queryKey: ["callerRole"],
    queryFn: async () => {
      if (!actor) throw new Error("Actor not ready");
      return actor.getCallerUserRole();
    },
    enabled: !!actor && !isFetching,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });

  if (role.data === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas text-muted">
        {role.isError
          ? "Could not check ownership — reload to retry."
          : "Loading…"}
      </div>
    );
  }
  return role.data === UserRole.admin ? <ChatView /> : <NotYourChatbot />;
}

export default function App() {
  const { isAuthenticated, isInitializing } = useInternetIdentity();

  // Dev-only: with VITE_DEV_INFERENCE_KEY set, skip the sign-in gate so the
  // browser-direct inference path can be exercised without a local replica.
  // devCredentials() is null in production builds.
  if (devCredentials()) {
    return <ChatView />;
  }

  if (isInitializing) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas text-muted">
        Loading…
      </div>
    );
  }

  return isAuthenticated ? <OwnerGate /> : <LoginScreen />;
}
