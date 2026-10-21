// Caffeine Inference credential brokering for the frontend-direct path. The
// canister never executes completions itself, and since gateway ephemeral
// keys exist it never hands out its own key either: each grant mints a
// short-lived child key (POST /v1/ephemeral-keys, authenticated with the
// platform-provisioned parent key), so the browser only ever holds a
// credential that expires on its own. The parent key never leaves this
// canister.

import { fromEnv; _Ic; _Helpers } "mo:caffeineai-inference-client/Config";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Prim "mo:⛔";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Iter "mo:core/Iter";

module {
  public type Credentials = {
    baseUrl : Text;
    apiKey : Text;
    // RFC 3339 expiry of the ephemeral key; the frontend refreshes shortly
    // before it and recovers from a 401 after it.
    expiresAt : Text;
  };

  public type GrantWindow = {
    var windowStartNs : Int;
    var grantsInWindow : Nat;
  };

  public type CachedGrant = {
    credentials : Credentials;
    mintedAtNs : Int;
  };

  let grantWindowNs : Int = 3_600_000_000_000; // 1 hour
  let maxGrantsPerWindow : Nat = 30;
  let ephemeralTtlSeconds : Nat = 10_800; // 3 hours, the gateway ceiling
  // Reuse window for cached child keys. Short relative to the TTL so a
  // platform key rotation outside an upgrade (which would orphan cached
  // children) self-heals quickly, long enough to absorb reload bursts.
  let cacheReuseNs : Int = 900_000_000_000; // 15 minutes

  // True when the platform has provisioned inference credentials for this
  // canister. Reveals nothing about the credentials themselves.
  public func isConfigured<system>() : Bool {
    Prim.envVar<system>("CAFFEINE_INFERENCE_API_KEY") != null;
  };

  // A recently minted child for this principal, if it is still young enough
  // to hand out again. Cache hits are free: only actual mints rate-charge.
  public func cachedGrant(
    cache : Map.Map<Principal, CachedGrant>,
    caller : Principal,
    nowNs : Int,
  ) : ?Credentials {
    switch (cache.get(caller)) {
      case (?entry) {
        if (nowNs - entry.mintedAtNs < cacheReuseNs) {
          ?entry.credentials;
        } else {
          cache.remove(caller);
          null;
        };
      };
      case null null;
    };
  };

  // Per-principal sliding window so no caller can hammer the mint path (each
  // grant is one HTTP outcall, which costs cycles).
  public func checkRateLimit(
    grants : Map.Map<Principal, GrantWindow>,
    caller : Principal,
    nowNs : Int,
  ) {
    switch (grants.get(caller)) {
      case (?window) {
        if (nowNs - window.windowStartNs > grantWindowNs) {
          window.windowStartNs := nowNs;
          window.grantsInWindow := 0;
        };
        if (window.grantsInWindow >= maxGrantsPerWindow) {
          Runtime.trap("Rate limited: too many credential requests, try again later");
        };
        window.grantsInWindow += 1;
      };
      case null {
        grants.add(caller, { var windowStartNs = nowNs; var grantsInWindow = 1 });
      };
    };
  };

  // Mints an ephemeral child of this canister's platform key and returns it.
  // The parent key authenticates the mint and is never part of the result.
  // `grantLabel` is attribution only (shows up in key listings and audit events).
  public func mintEphemeral<system>(grantLabel : Text) : async* Credentials {
    let config = fromEnv<system>();
    let parentKey = switch (config.auth) {
      case (?#bearer(key)) key;
      case _ Runtime.trap("Inference credentials unavailable");
    };
    // The label is a principal or the probe tag: base32 and dashes only, so
    // it needs no JSON escaping.
    let body = "{\"ttl_seconds\":" # ephemeralTtlSeconds.toText()
    # ",\"label\":\"" # grantLabel # "\"}";
    let request : _Ic.HttpRequestArgs = {
      config with
      url = config.baseUrl # "/v1/ephemeral-keys";
      method = #post;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # parentKey },
      ];
      body = ?body.encodeUtf8();
    };
    let response = await (with cycles = config.cycles) _Ic.http_request(request);
    if (response.status < 200 or response.status >= 300) {
      Runtime.trap(_Helpers.rejectMessage(response.status, response.body, "ephemeral mint refused"));
    };
    let text = switch (response.body.decodeUtf8()) {
      case (?text) text;
      case null Runtime.trap("ephemeral mint response is not UTF-8");
    };
    // The response is this gateway's own fixed contract:
    // {"id":"…","key":"cfa_eph_…","last4":"…","expires_at":"…"} — every value
    // is base62/uuid/RFC 3339, so no JSON escapes can occur and plain string
    // extraction is sound.
    let key = switch (extractString(text, "key")) {
      case (?key) key;
      case null Runtime.trap("ephemeral mint response carries no key");
    };
    let expiresAt = switch (extractString(text, "expires_at")) {
      case (?expiry) expiry;
      case null Runtime.trap("ephemeral mint response carries no expires_at");
    };
    { baseUrl = config.baseUrl; apiKey = key; expiresAt };
  };

  // The value of `"<name>":"<value>"` in a JSON object whose values contain
  // no escapes (see the call site for why that holds here).
  func extractString(json : Text, name : Text) : ?Text {
    let marker = "\"" # name # "\":\"";
    let parts = json.split(#text marker).toArray();
    if (parts.size() < 2) {
      return null;
    };
    let tail = parts[1];
    let value = tail.split(#char '\"').toArray()[0];
    if (value.size() == 0) { null } else { ?value };
  };

  // Display-safe tail of a key for probe output; never the key itself.
  public func last4(key : Text) : Text {
    let chars = key.chars().toArray();
    if (chars.size() < 4) { return key };
    Text.fromIter(Prim.Array_tabulate(4, func(i) = chars[chars.size() - 4 + i]).values());
  };
};
