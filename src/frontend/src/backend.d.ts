import type { Principal } from "@icp-sdk/core/principal";
export interface Some<T> {
    __kind__: "Some";
    value: T;
}
export interface None {
    __kind__: "None";
}
export type Option<T> = Some<T> | None;
export type Result = {
    __kind__: "ok";
    ok: null;
} | {
    __kind__: "err";
    err: Error_;
};
export interface StoredMessage {
    content: string;
    role: Variant_user_assistant;
    createdAtNs: bigint;
}
export interface Summary {
    content: string;
    createdAtNs: bigint;
    coversCount: bigint;
}
export interface Credentials {
    expiresAt: string;
    baseUrl: string;
    apiKey: string;
}
export interface MessagePage {
    total: bigint;
    messages: Array<StoredMessage>;
    summary?: Summary;
}
export type Error_ = {
    __kind__: "FrontendOriginsNotConfigured";
    FrontendOriginsNotConfigured: null;
} | {
    __kind__: "MixedSsoSources";
    MixedSsoSources: {
        otherKeys: Array<string>;
        ssoKeys: Array<string>;
    };
} | {
    __kind__: "Stale";
    Stale: {
        ageNs: bigint;
    };
} | {
    __kind__: "MalformedCandid";
    MalformedCandid: null;
} | {
    __kind__: "AmbiguousAttribute";
    AmbiguousAttribute: {
        field: string;
        sources: Array<string>;
    };
} | {
    __kind__: "NoAttributes";
    NoAttributes: null;
} | {
    __kind__: "UnknownNonce";
    UnknownNonce: null;
} | {
    __kind__: "UntrustedSsoSource";
    UntrustedSsoSource: {
        domain: string;
    };
} | {
    __kind__: "MissingField";
    MissingField: string;
} | {
    __kind__: "FrontendOriginMismatch";
    FrontendOriginMismatch: {
        got: string;
        expected: Array<string>;
    };
};
export interface ConversationSummary {
    id: bigint;
    title: string;
    updatedAtNs: bigint;
    messageCount: bigint;
}
export enum UserRole {
    admin = "admin",
    user = "user",
    guest = "guest"
}
export enum Variant_user_assistant {
    user = "user",
    assistant = "assistant"
}
export interface backendInterface {
    assignCallerUserRole(user: Principal, role: UserRole): Promise<void>;
    deleteConversation(id: bigint): Promise<void>;
    getCallerUserRole(): Promise<UserRole>;
    getConversationPage(id: bigint, start: bigint): Promise<MessagePage>;
    getInferenceCredentials(): Promise<Credentials>;
    isCallerAdmin(): Promise<boolean>;
    isInferenceConfigured(): Promise<boolean>;
    listConversations(): Promise<Array<ConversationSummary>>;
    probeEphemeralMint(): Promise<{
        expiresAt: string;
        last4: string;
    }>;
    recordExchange(conversationId: bigint | null, userContent: string, assistantContent: string): Promise<bigint>;
    setConversationSummary(id: bigint, coversCount: bigint, content: string): Promise<void>;
}
