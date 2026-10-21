// Composition root for the Snappy Chat canister.
//
// The app's chat UI talks to Caffeine Inference directly from the browser for
// low latency; completions never pass through this canister. Its only job is
// credential brokering: `getInferenceCredentials` mints a short-lived
// ephemeral child of the platform-provisioned app key (gateway
// `POST /v1/ephemeral-keys`) and hands that to signed-in users, so the
// browser never holds anything longer-lived than the child's TTL and the
// parent key never leaves this canister. Anonymous callers are rejected and
// grants are rate-limited per principal.
//
// The parent key is read from the canister environment on every mint and is
// never written to stable state, logged, or returned.

import AccessControl "mo:caffeineai-authorization/access-control";
import MixinAuthorization "mo:caffeineai-authorization/MixinAuthorization";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";

import History "lib/history";
import Inference "lib/inference";

actor {
  // ---- Stable state (types only — initial values come from the migration) ----

  let accessControlState : AccessControl.AccessControlState;

  // Per-user conversation history, recorded by the frontend after each
  // completed exchange (the completions themselves never pass through here).
  let conversations : Map.Map<Principal, History.UserChats>;

  // Per-principal sliding-window counters for credential mints. Transient:
  // rate limiting is bookkeeping over the last hour, and surviving an
  // upgrade would keep callers blocked through a redeploy.
  transient let credentialGrants = Map.empty<Principal, Inference.GrantWindow>();

  // ---- Authorization ----

  include MixinAuthorization(accessControlState, null);

  // Single-user app: the first principal to sign in becomes the owner
  // (AccessControl.initialize assigns #admin exactly once, during the
  // Internet Identity sign-in flow) and every call is owner-only from then
  // on. Anyone else is pointed at remixing their own copy.
  func requireOwner(caller : Principal) {
    if (caller.isAnonymous()) {
      Runtime.trap("Unauthorized: sign in to use this chatbot");
    };
    switch (accessControlState.userRoles.get(caller)) {
      case (?#admin) {};
      case (_) {
        Runtime.trap(
          "This chatbot belongs to its owner. Remix your own copy from the Caffeine App Market."
        );
      };
    };
  };

  // Anonymous-safe diagnostic: reports only whether the platform has
  // provisioned inference credentials, never anything about them.
  public shared func isInferenceConfigured() : async Bool {
    Inference.isConfigured<system>();
  };

  // Anonymous-safe diagnostic for the mint path: performs a real ephemeral
  // mint and reports metadata only — the key itself is discarded, so nothing
  // spendable is exposed. Shares the per-principal rate window (all anonymous
  // callers are one principal), which bounds the outcall spend it can cause.
  public shared ({ caller }) func probeEphemeralMint() : async {
    last4 : Text;
    expiresAt : Text;
  } {
    Inference.checkRateLimit(credentialGrants, caller, Time.now());
    let minted = await* Inference.mintEphemeral<system>("probe");
    { last4 = Inference.last4(minted.apiKey); expiresAt = minted.expiresAt };
  };

  // ---- Inference credential brokering ----

  // Recently minted child keys, per principal, so a burst of page reloads
  // reuses one key instead of minting (and rate-charging) each time.
  // Transient on purpose: an upgrade — which is also when the platform
  // rotates the parent and revokes all children — starts it empty.
  transient let childCache = Map.empty<Principal, Inference.CachedGrant>();

  // Mints and returns a short-lived ephemeral key for the caller. Any signed-in
  // user of this app can obtain one — direct browser calls are the point of
  // this app — but what they get expires on its own (3h TTL), spends against
  // the app key's caps, and dies with the parent on every app deploy. The
  // caller must be authenticated, mints are rate-limited per principal, the
  // grant is labeled with the caller for attribution, and the frontend keeps
  // the key in memory only.
  public shared ({ caller }) func getInferenceCredentials() : async Inference.Credentials {
    requireOwner(caller);
    let now = Time.now();
    switch (Inference.cachedGrant(childCache, caller, now)) {
      case (?credentials) { return credentials };
      case null {};
    };
    Inference.checkRateLimit(credentialGrants, caller, now);
    let minted = await* Inference.mintEphemeral<system>(caller.toText());
    childCache.add(caller, { credentials = minted; mintedAtNs = Time.now() });
    minted;
  };

  // ---- Conversation history ----

  public query ({ caller }) func listConversations() : async [History.ConversationSummary] {
    requireOwner(caller);
    History.list(conversations, caller);
  };

  // One page (25 messages) of a conversation, oldest-first — bounded so a
  // long conversation never exceeds the reply size limit.
  public query ({ caller }) func getConversationPage(id : Nat, start : Nat) : async History.MessagePage {
    requireOwner(caller);
    History.page(conversations, caller, id, start);
  };

  // Appends one completed user/assistant exchange; a null id starts a new
  // conversation. Returns the conversation id either way.
  public shared ({ caller }) func recordExchange(
    conversationId : ?Nat,
    userContent : Text,
    assistantContent : Text,
  ) : async Nat {
    requireOwner(caller);
    History.recordExchange(conversations, caller, conversationId, userContent, assistantContent, Time.now());
  };

  // Stores a running summary alongside the (untouched) full transcript; the
  // frontend uses it to keep prompts bounded on long conversations.
  public shared ({ caller }) func setConversationSummary(
    id : Nat,
    coversCount : Nat,
    content : Text,
  ) : async () {
    requireOwner(caller);
    History.setSummary(conversations, caller, id, coversCount, content, Time.now());
  };

  public shared ({ caller }) func deleteConversation(id : Nat) : async () {
    requireOwner(caller);
    History.delete(conversations, caller, id);
  };
};
