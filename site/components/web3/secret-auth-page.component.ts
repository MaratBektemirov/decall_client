import styles from "./secret-auth-page.module.css";

import { AbstractComponent, componentsRegistryService, Rx, RxBucket } from "cruzo";
import { UI_KIT } from "cruzo/ui-components/const";
import { SecretAuthComponent } from "cruzo-web3/components/secret-auth";
import type { SecretAuthState } from "cruzo-web3";

import { fetchAuthChallenge } from "site/services/auth-api";
import { pubKeyToCallIdentity } from "site/utils/call-identity";
import { ChatSession, type ChatMessage } from "site/webrtc/chat-session";
import "site/web3-setup";

export class SecretAuthPageComponent extends AbstractComponent {
  static selector = "secret-auth-page-component";

  dependencies = new Set([SecretAuthComponent.selector]);

  callIdentity$ = this.newRx("");
  hasCallIdentity$ = this.newRx(false);
  copyLabel$ = this.newRx("Copy ID");
  challengeLoading$ = this.newRx(false);
  challengeError$ = this.newRx("");

  joinCallId$ = this.newRx("");
  chatStatus$ = this.newRx("idle");
  chatMessages: Rx<ChatMessage>[] = [];
  chatDraft$ = this.newRx("");

  innerBucket = new RxBucket({
    secretAuth: {
      config: {
        title: "Sign in",
        devMode: import.meta.env.DEV,
      },
    },
  });

  secretAuthState$ = this.newRxStateFromBucket(this.innerBucket, "secretAuth");

  private identityGeneration = 0;
  private challengeGeneration = 0;
  private chatSession: ChatSession | null = null;

  getHTML() {
    const k = UI_KIT;

    return `<div class="${styles.page}">
        <header class="${styles.header}">
          <img class="${styles.logo}" src="/logo.svg" alt="Decall">
        </header>

        <div class="${styles.identityCard}" attached="{{ root.hasCallIdentity$::rx }}">
          <div class="${styles.identityHead}">
            <h3 class="${styles.identityTitle}">Your ID</h3>
          </div>
          <div class="${styles.identityField}">
            <span class="${styles.identityLabel}">Share this to receive a chat</span>
            <div class="${styles.identityEmojis}">{{ root.callIdentity$::rx }}</div>
            <div style="margin-top: 12px; display: flex; justify-content: center;">
                <button type="button"
                 class="${k}_button ${k}_button-s ${k}_button-secondary"
                 onclick="{{ root.copyCallID() }}">
                 {{ root.copyLabel$::rx }}   
                </button>
                </div>
          </div>
          <p class="${styles.identityHint}">
            Same key always gives the same ID on every device.
          </p>
        </div>

        <div class="${styles.panel}" attached="{{ !root.hasCallIdentity$::rx }}">
          <p class="${styles.challengeError}" attached="{{ root.challengeError$::rx }}">
            {{ root.challengeError$::rx }}
          </p>

          <div>
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-secondary"
              disabled="{{ root.challengeLoading$::rx }}"
              onclick="{{ root.refreshChallenge() }}">
              {{ root.challengeLoading$::rx ? 'Loading challenge…' : 'Refresh challenge' }}
            </button>
          </div>

          <secret-auth-component
            component-id="secretAuth"
            bucket-id="${this.innerBucket.id}">
          </secret-auth-component>
        </div>

        <div class="${styles.chatCard}" attached="{{ root.hasCallIdentity$::rx }}">
          <div class="${styles.identityHead}">
            <h3 class="${styles.identityTitle}">P2P chat</h3>
            <span class="${styles.chatStatus}">{{ root.chatStatus$::rx }}</span>
          </div>

          <div class="${styles.chatActions}">
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-primary"
              onclick="{{ root.openChatRoom() }}">Open room</button>
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-secondary"
              onclick="{{ root.disconnectChat() }}">Leave</button>
          </div>

          <div class="${styles.joinRow}">
            <input type="text"
              class="${k}_input ${styles.joinInput}"
              placeholder="Enter Call ID to join"
              value="{{ root.joinCallId$::rx }}"
              oninput="{{ root.joinCallId$.update(event.target.value) }}">
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-primary"
              onclick="{{ root.joinChatRoom() }}">Join</button>
          </div>

          <div class="${styles.messages}">
            <div repeat="{{ root.chatMessages }}" class="${styles.messageRow}">
              <div class="${styles.message} ${styles.messageMe}" attached="{{ this::rx.from === 'me' }}">{{ this::rx.text }}</div>
              <div class="${styles.message} ${styles.messagePeer}" attached="{{ this::rx.from === 'peer' }}">{{ this::rx.text }}</div>
              <div class="${styles.message} ${styles.messageSystem}" attached="{{ this::rx.from === 'system' }}">{{ this::rx.text }}</div>
            </div>
          </div>

          <div class="${styles.composeRow}">
            <textarea
              class="${k}_textarea ${styles.chatInput}"
              placeholder="Message"
              value="{{ root.chatDraft$::rx }}"
              oninput="{{ root.chatDraft$.update(event.target.value) }}"></textarea>
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-primary"
              onclick="{{ root.sendChat() }}">Send</button>
          </div>
        </div>
      </div>`;
  }

  connectedCallback() {
    componentsRegistryService.connectBucket(this.innerBucket);
    this.innerBucket.setState("secretAuth", this.emptyAuthState());
    super.connectedCallback();

    this.newRxFunc((state) => {
      this.updateCallIdentity(state);
    }, this.secretAuthState$);

    this.loadChallenge();
  }

  disconnectedCallback() {
    this.disconnectChat();
    super.disconnectedCallback();
  }

  refreshChallenge() {
    this.disconnectChat();
    this.hasCallIdentity$.update(false);
    this.callIdentity$.update("");
    this.loadChallenge();
  }

  openChatRoom() {
    const roomId = this.callIdentity$.actual;
    if (!roomId) return;
    this.startChat(roomId, "host");
  }

  joinChatRoom() {
    const roomId = (this.joinCallId$.actual ?? "").trim();
    if (!roomId) return;
    this.startChat(roomId, "guest");
  }

  sendChat() {
    this.chatSession?.send(this.chatDraft$.actual ?? "");
    this.chatDraft$.update("");
  }

  disconnectChat() {
    this.chatSession?.close();
    this.chatSession = null;
    this.chatStatus$.update("idle");
  }

  copyCallID() {
    const id = this.callIdentity$.actual;
    if (!id) return;

    navigator.clipboard.writeText(id)
        .then(() => {
          this.copyLabel$.update("Copied! ✓");

          setTimeout(() => {
            this.copyLabel$.update("Copy ID");
          }, 2000);
        })
        .catch((err) => {
          console.error("Failed to copy ID: ", err);
        });
  }

  private startChat(roomId: string, role: "host" | "guest") {
    this.disconnectChat();
    this.chatMessages = [];
    this.template.detectChanges();

    this.chatSession = new ChatSession(
      (message) => {
        this.appendChatMessage(message);
      },
      (status) => {
        this.chatStatus$.update(status);
      },
    );

    const action = role === "host"
      ? this.chatSession.openRoom(roomId)
      : this.chatSession.joinRoom(roomId);

    action.catch((err: unknown) => {
      const text = err instanceof Error ? err.message : "chat connection failed";
      this.appendChatMessage({ from: "system", text });
      this.chatStatus$.update("error");
    });
  }

  private appendChatMessage(message: ChatMessage) {
    this.chatMessages = [...this.chatMessages, this.newRx(message)];
    this.template.detectChanges();
  }

  private loadChallenge() {
    const generation = ++this.challengeGeneration;

    this.challengeLoading$.update(true);
    this.challengeError$.update("");

    fetchAuthChallenge()
      .then((challenge) => {
        if (generation !== this.challengeGeneration) return;

        this.innerBucket.setState("secretAuth", {
          ...this.emptyAuthState(),
          challenge,
        });
      })
      .catch((err: unknown) => {
        if (generation !== this.challengeGeneration) return;

        const message = err instanceof Error ? err.message : "challenge request failed";
        this.challengeError$.update(message);
        this.innerBucket.setState("secretAuth", this.emptyAuthState());
      })
      .finally(() => {
        if (generation !== this.challengeGeneration) return;
        this.challengeLoading$.update(false);
      });
  }

  private updateCallIdentity(state: SecretAuthState | null | undefined) {
    const pubKey = state?.pubKey;

    if (!pubKey || !state?.signed) {
      this.hasCallIdentity$.update(false);
      this.callIdentity$.update("");
      return;
    }

    const generation = ++this.identityGeneration;

    pubKeyToCallIdentity(pubKey).then((identity) => {
      if (generation !== this.identityGeneration) return;
      this.callIdentity$.update(identity);
      this.hasCallIdentity$.update(true);
    });
  }

  private emptyAuthState(): SecretAuthState {
    return {
      challenge: null,
      proof: null,
      signed: false,
      pubKey: null,
      mode: null,
      wallet: null,
      passkey: null,
    };
  }
}

componentsRegistryService.define(SecretAuthPageComponent);
