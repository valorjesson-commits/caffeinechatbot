// Initial migration — introduces all stable state for the CaffeineChatBot
// canister in its final shape (fresh install, single-entry chain).
//
// OldActor = {} because this is the first migration. NewActor enumerates
// every stable field declared in main.mo with its initial value.
// Self-contained: only mo:core imports; the authorization and history types
// are inlined because the chain replays forever.

import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";

module {
  // First migration — the canister starts empty.
  type OldActor = {};

  type UserRole = { #admin; #user; #guest };

  // Mirrors AccessControl.AccessControlState from
  // caffeineai-authorization@1.0.1.
  type AccessControlState = {
    var adminAssigned : Bool;
    userRoles : Map.Map<Principal, UserRole>;
  };

  // Mirror of lib/history.mo's stored shapes: per-user multi-chat history,
  // each conversation carrying its transcript plus an optional running
  // summary over a prefix of it.
  type StoredMessage = {
    role : { #user; #assistant };
    content : Text;
    createdAtNs : Int;
  };

  type Summary = {
    content : Text;
    coversCount : Nat;
    createdAtNs : Int;
  };

  type Conversation = {
    id : Nat;
    var title : Text;
    createdAtNs : Int;
    var updatedAtNs : Int;
    var summary : ?Summary;
    messages : List.List<StoredMessage>;
  };

  type UserChats = {
    var nextId : Nat;
    chats : Map.Map<Nat, Conversation>;
  };

  type NewActor = {
    accessControlState : AccessControlState;
    conversations : Map.Map<Principal, UserChats>;
  };

  public func migration(_old : OldActor) : NewActor {
    {
      accessControlState = {
        var adminAssigned = false;
        userRoles = Map.empty();
      };
      conversations = Map.empty();
    };
  };
};
