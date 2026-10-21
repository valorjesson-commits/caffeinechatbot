// Per-user conversation history. The browser talks to the inference gateway
// directly, so the canister only sees what the frontend records here: one
// call per completed exchange. Reads are queries; everything is scoped to
// the calling principal.

import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Array "mo:core/Array";

module {
  public type StoredMessage = {
    role : { #user; #assistant };
    content : Text;
    createdAtNs : Int;
  };

  // A running summary of the conversation's first `coversCount` messages.
  // The full transcript is always kept; the summary only stands in for that
  // prefix when the frontend builds a model prompt.
  public type Summary = {
    content : Text;
    coversCount : Nat;
    createdAtNs : Int;
  };

  public type Conversation = {
    id : Nat;
    var title : Text;
    createdAtNs : Int;
    var updatedAtNs : Int;
    var summary : ?Summary;
    messages : List.List<StoredMessage>;
  };

  public type UserChats = {
    var nextId : Nat;
    chats : Map.Map<Nat, Conversation>;
  };

  public type MessagePage = {
    messages : [StoredMessage];
    total : Nat;
    summary : ?Summary;
  };

  public type ConversationSummary = {
    id : Nat;
    title : Text;
    updatedAtNs : Int;
    messageCount : Nat;
  };

  // A response must stay under the IC's ~2MB reply limit: 25 messages at the
  // 40k-char content cap is ~1MB worst case.
  let pageSize : Nat = 25;

  let maxConversationsPerUser : Nat = 100;
  let maxMessagesPerConversation : Nat = 400;
  let maxContentChars : Nat = 40_000;
  let maxSummaryChars : Nat = 6_000;
  let maxTitleChars : Nat = 48;

  func userChats(all : Map.Map<Principal, UserChats>, caller : Principal) : UserChats {
    switch (all.get(caller)) {
      case (?chats) chats;
      case null {
        let fresh : UserChats = { var nextId = 0; chats = Map.empty() };
        all.add(caller, fresh);
        fresh;
      };
    };
  };

  func ownConversation(all : Map.Map<Principal, UserChats>, caller : Principal, id : Nat) : Conversation {
    switch (all.get(caller)) {
      case (?chats) {
        switch (chats.chats.get(id)) {
          case (?conversation) conversation;
          case null Runtime.trap("Unknown conversation");
        };
      };
      case null Runtime.trap("Unknown conversation");
    };
  };

  // Newest-first summaries of the caller's conversations.
  public func list(all : Map.Map<Principal, UserChats>, caller : Principal) : [ConversationSummary] {
    switch (all.get(caller)) {
      case null [];
      case (?chats) {
        let summaries = chats.chats.values().map(
          func(c) = {
            id = c.id;
            title = c.title;
            updatedAtNs = c.updatedAtNs;
            messageCount = c.messages.size();
          }
        ).toArray();
        summaries.sort(func(a, b) = Int.compare(b.updatedAtNs, a.updatedAtNs));
      };
    };
  };

  // One bounded page of a conversation, oldest-first from `start`.
  public func page(all : Map.Map<Principal, UserChats>, caller : Principal, id : Nat, start : Nat) : MessagePage {
    let conversation = ownConversation(all, caller, id);
    let messages = conversation.messages;
    let total = messages.size();
    if (start >= total) {
      return { messages = []; total; summary = conversation.summary };
    };
    let end = Nat.min(start + pageSize, total);
    let count : Nat = if (end > start) { end - start : Nat } else { 0 };
    let page = Array.tabulate(count, func(i) = messages.at(start + i));
    { messages = page; total; summary = conversation.summary };
  };

  // Records one completed user/assistant exchange, creating the conversation
  // when `conversationId` is null. Returns the conversation id either way.
  public func recordExchange(
    all : Map.Map<Principal, UserChats>,
    caller : Principal,
    conversationId : ?Nat,
    userContent : Text,
    assistantContent : Text,
    nowNs : Int,
  ) : Nat {
    if (userContent.size() > maxContentChars or assistantContent.size() > maxContentChars) {
      Runtime.trap("Message too long to store");
    };
    let chats = userChats(all, caller);
    let conversation = switch (conversationId) {
      case (?id) ownConversation(all, caller, id);
      case null {
        if (chats.chats.size() >= maxConversationsPerUser) {
          Runtime.trap("Conversation limit reached — delete old chats first");
        };
        let id = chats.nextId;
        chats.nextId += 1;
        let fresh : Conversation = {
          id;
          var title = titleFrom(userContent);
          createdAtNs = nowNs;
          var updatedAtNs = nowNs;
          var summary = null;
          messages = List.empty();
        };
        chats.chats.add(id, fresh);
        fresh;
      };
    };
    if (conversation.messages.size() + 2 > maxMessagesPerConversation) {
      Runtime.trap("Conversation is full — start a new chat");
    };
    conversation.messages.add({
      role = #user;
      content = userContent;
      createdAtNs = nowNs;
    });
    conversation.messages.add({
      role = #assistant;
      content = assistantContent;
      createdAtNs = nowNs;
    });
    conversation.updatedAtNs := nowNs;
    conversation.id;
  };

  // Stores a running summary of the first `coversCount` messages. Never
  // deletes anything: the transcript stays complete, the summary stands in
  // for its prefix in prompts. Coverage is monotonic and the prefix it
  // references is immutable (messages are append-only), so replays and
  // concurrent appends are harmless.
  public func setSummary(
    all : Map.Map<Principal, UserChats>,
    caller : Principal,
    id : Nat,
    coversCount : Nat,
    content : Text,
    nowNs : Int,
  ) : () {
    if (content.size() == 0 or content.size() > maxSummaryChars) {
      Runtime.trap("Summary must be 1 to 6000 characters");
    };
    let conversation = ownConversation(all, caller, id);
    if (coversCount > conversation.messages.size()) {
      Runtime.trap("Summary covers more messages than exist");
    };
    switch (conversation.summary) {
      case (?existing) {
        if (coversCount <= existing.coversCount) {
          Runtime.trap("Summary coverage must grow");
        };
      };
      case null {};
    };
    conversation.summary := ?{ content; coversCount; createdAtNs = nowNs };
  };

  public func delete(all : Map.Map<Principal, UserChats>, caller : Principal, id : Nat) : () {
    ignore ownConversation(all, caller, id);
    switch (all.get(caller)) {
      case (?chats) chats.chats.remove(id);
      case null {};
    };
  };

  // First non-marker line of the first message, bounded, as the conversation
  // title. Image markers ([Attached image "…"]) and their description lines
  // stand in for attached images and make poor titles.
  func titleFrom(content : Text) : Text {
    var firstLine = "";
    var skippingImageBlock = false;
    label pick for (line in content.split(#char '\n')) {
      if (line.startsWith(#text "[Attached image ")) {
        skippingImageBlock := true;
      } else if (line == "") {
        skippingImageBlock := false;
      } else if (not skippingImageBlock) {
        firstLine := line;
        break pick;
      };
    };
    if (firstLine == "") {
      return "Image chat";
    };
    let chars = firstLine.chars().toArray();
    if (chars.size() <= maxTitleChars) {
      return firstLine;
    };
    Text.fromIter(chars.sliceToArray(0, maxTitleChars).values()) # "…";
  };
};
