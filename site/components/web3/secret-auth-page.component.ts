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
  private localStream: MediaStream | null = null;
  isAudioEnabled$ = this.newRx(false);
  isVideoEnabled$ = this.newRx(false);
  // states for the remote user
  isRemoteAudioEnabled$ = this.newRx(true);
  isRemoteVideoEnabled$ = this.newRx(true);
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
            
            <div style="display: flex; gap: 10px; margin-bottom: 10px; padding: 0 15px;">
            
            <div style="position: relative; width: 50%; aspect-ratio: 4/3;">
              <video id="localVideo" autoplay playsinline muted 
                     style="width: 100%; height: 100%; background: #000; border-radius: 8px; object-fit: cover;">
              </video>
              
              <div style="position: absolute; bottom: 8px; right: 8px; display: flex; gap: 6px;">
                <div attached="{{ !root.isAudioEnabled$::rx }}" 
                     style="background: rgba(0,0,0,0.7); padding: 4px 6px; border-radius: 6px; font-size: 14px;">
                  🔇
                </div>
                <div attached="{{ !root.isVideoEnabled$::rx }}" 
                     style="background: rgba(0,0,0,0.7); padding: 4px 6px; border-radius: 6px; font-size: 14px;">
                  🚫
                </div>
              </div>
            </div>
            
            <div style="position: relative; width: 50%; aspect-ratio: 4/3;">
              <video id="remoteVideo" autoplay playsinline 
                     style="width: 100%; height: 100%; background: #000; border-radius: 8px; object-fit: cover;">
              </video>
              
              <div style="position: absolute; bottom: 8px; right: 8px; display: flex; gap: 6px;">
                <div attached="{{ !root.isRemoteAudioEnabled$::rx }}" 
                     style="background: rgba(0,0,0,0.7); padding: 4px 6px; border-radius: 6px; font-size: 14px;">
                  🔇
                </div>
                <div attached="{{ !root.isRemoteVideoEnabled$::rx }}" 
                     style="background: rgba(0,0,0,0.7); padding: 4px 6px; border-radius: 6px; font-size: 14px;">
                  🚫
                </div>
              </div>
            </div>
          </div>

          <div style="display: flex; justify-content: center; gap: 12px; margin-bottom: 15px;">
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-secondary"
              onclick="{{ root.toggleVideo() }}">
              {{ root.isVideoEnabled$::rx ? 'Camera Off' : 'Camera On' }}
            </button>
            <button type="button"
              class="${k}_button ${k}_button-s ${k}_button-secondary"
              onclick="{{ root.toggleAudio() }}">
              {{ root.isAudioEnabled$::rx ? 'Audio Off' : 'Audio On' }}
            </button>
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

    // turn off camera and audio
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
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

  private async startCamera() {
    try {
      // trying to request access to the camera and audio
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
    } catch (err) {
      console.warn("Camera not found or denied, falling back to audio only...", err);

      try {
        // if video unavailable, trying to request audio
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true
        });
      } catch (audioErr) {
        // if audio unavailable (or user denied the request)
        console.error("Failed to access microphone:", audioErr);
        this.chatStatus$.update("media error");
        throw audioErr;
      }
    }
      const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
      if (localVideo) {
        localVideo.srcObject = this.localStream;

        const audioTrack = this.localStream.getAudioTracks()[0];
        const videoTrack = this.localStream.getVideoTracks()[0];

        this.isAudioEnabled$.update(audioTrack ? audioTrack.enabled : false);
        this.isVideoEnabled$.update(videoTrack ? videoTrack.enabled : false);
      }
  }

  toggleAudio() {
    if (!this.localStream) return;

    const audioTrack = this.localStream.getTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;

      this.isAudioEnabled$.update(audioTrack.enabled);

      this.chatSession?.send(`CMD:AUDIO:${audioTrack.enabled ? "ON" : "OFF"}`);
    }
  }

  toggleVideo() {
    if (!this.localStream) return;

    const videoTrack = this.localStream.getVideoTracks()[0];

    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      this.isVideoEnabled$.update(videoTrack.enabled);

      this.chatSession?.send(`CMD:VIDEO:${videoTrack.enabled ? "ON" : "OFF"}`);
    }
  }

  private async startChat(roomId: string, role: "host" | "guest") {
    this.disconnectChat();
    this.chatMessages = [];
    this.template.detectChanges();

    // Turn on the camera BEFORE connecting to the room
    try {
      await this.startCamera();
    } catch (err) {
      return;
    }

    this.chatSession = new ChatSession(
      (message) => {

        if (message.text.startsWith("CMD:")) {

          if (message.from === "peer") {
            const parts = message.text.split(":");
            if (parts[1] === "AUDIO") this.isRemoteAudioEnabled$.update(parts[2] === "ON");
            if (parts[1] === "VIDEO") this.isRemoteVideoEnabled$.update(parts[2] === "ON");
          }
          return;
        }

        this.appendChatMessage(message);
      },

        (status) => {
        this.chatStatus$.update(status);

        if (status === "chat ready" || status === "open" || status === "connected") {
          setTimeout(() => {
            this.chatSession?.send(`CMD:AUDIO:${this.isAudioEnabled$.actual ? "ON" : "OFF"}`);
            this.chatSession?.send(`CMD:VIDEO:${this.isVideoEnabled$.actual ? "ON" : "OFF"}`);
          }, 500);
        }
      },

      this.localStream,

      (remoteStream) => {
        const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
        if (remoteVideo) {
          remoteVideo.srcObject = remoteStream;
        }
      }
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
