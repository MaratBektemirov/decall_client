import { MicrophoneIcon } from "site/icons/microphone";
import { MicrophoneOffIcon } from "site/icons/microphone-off";
import { VideoIcon } from "site/icons/video";
import { VideoOffIcon } from "site/icons/video-off";
import styles from "./secret-auth-page.module.css";

import { AbstractComponent, componentsRegistryService, Rx, RxBucket } from "cruzo";
import { UI_KIT } from "cruzo/ui-components/const";
import { SpinnerComponent, SpinnerConfig, SpinnerValue } from "cruzo/ui-components/spinner";
import { SecretAuthComponent } from "cruzo-web3/components/secret-auth";
import type { SecretAuthState } from "cruzo-web3";

import { fetchAuthChallenge } from "site/services/auth-api";
import { fetchTurnIceServers } from "site/services/ice-servers";
import { pubKeyToCallIdentity } from "site/utils/call-identity";
import { runIdentityScramble } from "site/utils/identity-scramble";
import { decallLog, formatDecallLogLine, subscribeDecallLog } from "site/utils/decall-log";
import { ChatSession, type ChatMessage } from "site/webrtc/chat-session";
import "site/web3-setup";

const EXIT_FADE_MS = 520;
const LOGO_SRC = `${import.meta.env.BASE_URL}logo.svg`;

const CHAT_CONNECTED_STATUSES = new Set(["chat ready", "open", "connected"]);

export class SecretAuthPageComponent extends AbstractComponent {
  static selector = "secret-auth-page-component";

  dependencies = new Set([
    SecretAuthComponent.selector,
    SpinnerComponent.selector,
    VideoIcon.selector,
    VideoOffIcon.selector,
    MicrophoneIcon.selector,
    MicrophoneOffIcon.selector,
  ]);

  callIdentity$ = this.newRx("");
  displayIdentity$ = this.newRx("");
  hasCallIdentity$ = this.newRx(false);
  showAuthPanel$ = this.newRx(true);
  showHeader$ = this.newRx(true);
  showPostAuth$ = this.newRx(false);
  authPanelExiting$ = this.newRx(false);
  postAuthEntering$ = this.newRx(false);
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
  callModalOpen$ = this.newRx(false);
  chatStatus$ = this.newRx("idle");
  connectionMode$ = this.newRx("");
  chatConnected$ = this.newRx(false);
  inCall$ = this.newRx(false);
  connectionLogText$ = this.newRx("");
  chatMessages: Rx<ChatMessage>[] = [];
  chatDraft$ = this.newRx("");

  innerBucket = new RxBucket({
    secretAuth: {
      config: {
        title: "Sign in",
        devMode: import.meta.env.DEV,
      },
    },
    chatSpinner: {
      config: SpinnerConfig({
        color: "#6b7280",
        size: "8px",
      }),
    },
  });

  secretAuthState$ = this.newRxStateFromBucket(this.innerBucket, "secretAuth");

  private identityGeneration = 0;
  private challengeGeneration = 0;
  private chatSession: ChatSession | null = null;
  private authTransitionStarted = false;
  private pendingIdentity = "";
  private stopIdentityScramble?: () => void;
  private unsubscribeDecallLog?: () => void;
  private connectionLogLines: string[] = [];

  getHTML() {
    const k = UI_KIT;

    return `<div class="${styles.page}">
        <header class="${styles.header} {{ root.authPanelExiting$::rx ? '${styles.headerExiting}' : '' }}"
          attached="{{ root.showHeader$::rx }}">
          <img class="${styles.logo}" src="${LOGO_SRC}" alt="Decall">
        </header>

        <div class="${styles.panel} {{ root.authPanelExiting$::rx ? '${styles.panelExiting}' : '' }}"
          attached="{{ root.showAuthPanel$::rx }}">
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

        <div class="${styles.postAuth}" attached="{{ root.showPostAuth$::rx }}">
          <div class="${styles.postAuthInner} {{ root.postAuthEntering$::rx ? '${styles.postAuthEnter}' : '${styles.postAuthHidden}' }}">
            <div class="${styles.chatCard}">
              <div class="${styles.identityHead}">
                <div class="${styles.chatHeadBrand}">
                  <img class="${styles.chatLogo}" src="${LOGO_SRC}" alt="Decall">
                  <div class="${styles.chatHeadText}">
                    <span class="${styles.chatBrandTitle}">Decentralized calls</span>
                    <div class="${styles.chatIdentityRow}">
                      <span class="${styles.chatIdentityId}">{{ root.displayIdentity$::rx }}</span>
                      <button type="button"
                        class="${k}_button ${k}_button-s ${k}_button-secondary"
                        onclick="{{ root.copyCallID() }}">
                        {{ root.copyLabel$::rx }}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="${styles.chatStatusBar}">
                  <div class="${styles.chatStatusGroup}">
                    <span class="${styles.chatStatus}">{{ root.chatStatus$::rx }}</span>
                    <div class="${styles.chatStatusSpinner}"
                      attached="{{ root.inCall$::rx && !root.chatConnected$::rx }}"
                      is="spinner"
                      component-id="chatSpinner"
                      bucket-id="${this.innerBucket.id}">
                      <div class="${styles.chatStatusSpinnerSlot}"></div>
                    </div>
                  </div>
                  <span class="${styles.chatTransport} ${styles.chatTransportP2p}"
                    attached="{{ root.connectionMode$::rx === 'P2P' }}"
                    title="Direct peer connection (host or STUN)">P2P</span>
                  <span class="${styles.chatTransport} ${styles.chatTransportTurn}"
                    attached="{{ root.connectionMode$::rx === 'TURN' }}"
                    title="Media relayed via TURN server">TURN</span>
                </div>
              </div>

              <div class="${styles.chatActions}">
                <button type="button"
                  class="${k}_button ${k}_button-s ${k}_button-primary"
                  attached="{{ !root.inCall$::rx }}"
                  onclick="{{ root.openChatRoom() }}">Wait</button>
                <button type="button"
                  class="${k}_button ${k}_button-s ${k}_button-primary"
                  attached="{{ !root.inCall$::rx }}"
                  onclick="{{ root.openCallModal() }}">Call</button>
                <button type="button"
                  class="${k}_button ${k}_button-s ${k}_button-secondary"
                  attached="{{ root.inCall$::rx }}"
                  onclick="{{ root.disconnectChat() }}">Leave</button>
              </div>

              <details class="${styles.connectionLog}" attached="{{ root.inCall$::rx }}">
                <summary class="${styles.connectionLogSummary}">Connection log</summary>
                <pre class="${styles.connectionLogPre}">{{ root.connectionLogText$::rx }}</pre>
              </details>

              <div class="${styles.videoGrid}">
                <div class="${styles.videoTile}">
                  <video id="localVideo" class="${styles.video}" autoplay playsinline muted></video>
                  <div class="${styles.videoOverlay}">
                    <div class="${styles.videoBadge}" attached="{{ !root.isAudioEnabled$::rx }}">
                      <microphone-off-icon class="${styles.videoBadgeIcon}"></microphone-off-icon>
                    </div>
                    <div class="${styles.videoBadge}" attached="{{ !root.isVideoEnabled$::rx }}">
                      <video-off-icon class="${styles.videoBadgeIcon}"></video-off-icon>
                    </div>
                  </div>
                </div>

                <div class="${styles.videoTile}">
                  <video id="remoteVideo" class="${styles.video}" autoplay playsinline></video>
                  <div class="${styles.videoOverlay}">
                    <div class="${styles.videoBadge}" attached="{{ !root.isRemoteAudioEnabled$::rx }}">
                      <microphone-off-icon class="${styles.videoBadgeIcon}"></microphone-off-icon>
                    </div>
                    <div class="${styles.videoBadge}" attached="{{ !root.isRemoteVideoEnabled$::rx }}">
                      <video-off-icon class="${styles.videoBadgeIcon}"></video-off-icon>
                    </div>
                  </div>
                </div>
              </div>

              <div class="${styles.mediaControls}">
                <button type="button"
                  class="${styles.mediaButton}"
                  aria-label="{{ root.isVideoEnabled$::rx ? 'Turn camera off' : 'Turn camera on' }}"
                  onclick="{{ root.toggleVideo() }}">
                  <video-icon class="${styles.mediaIcon}" attached="{{ root.isVideoEnabled$::rx }}"></video-icon>
                  <video-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ !root.isVideoEnabled$::rx }}"></video-off-icon>
                </button>
                <button type="button"
                  class="${styles.mediaButton}"
                  aria-label="{{ root.isAudioEnabled$::rx ? 'Turn microphone off' : 'Turn microphone on' }}"
                  onclick="{{ root.toggleAudio() }}">
                  <microphone-icon class="${styles.mediaIcon}" attached="{{ root.isAudioEnabled$::rx }}"></microphone-icon>
                  <microphone-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ !root.isAudioEnabled$::rx }}"></microphone-off-icon>
                </button>
              </div>

              <div class="${styles.chatMessenger}">
                <div class="${styles.messages}" attached="{{ root.chatConnected$::rx }}">
                  <div repeat="{{ root.chatMessages }}" class="${styles.messageRow}">
                    <div class="${styles.message} ${styles.messageMe}" attached="{{ this::rx.from === 'me' }}">{{ this::rx.text }}</div>
                    <div class="${styles.message} ${styles.messagePeer}" attached="{{ this::rx.from === 'peer' }}">{{ this::rx.text }}</div>
                    <div class="${styles.message} ${styles.messageSystem}" attached="{{ this::rx.from === 'system' }}">{{ this::rx.text }}</div>
                  </div>
                </div>

                <div class="${styles.composeRow}" attached="{{ root.chatConnected$::rx }}">
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
            </div>
          </div>
        </div>

        <div class="${styles.callModalBackdrop}"
          attached="{{ root.callModalOpen$::rx }}"
          onclick="{{ root.closeCallModal(event) }}">
          <div class="${styles.callModal}">
            <input type="text"
              class="${k}_input ${styles.callModalInput}"
              placeholder="Call ID"
              value="{{ root.joinCallId$::rx }}"
              oninput="{{ root.joinCallId$.update(event.target.value) }}">
            <div>
              <button type="button"
                class="${k}_button ${k}_button-s ${k}_button-primary mr_s"
                disabled="{{ !root.joinCallId$::rx }}"
                onclick="{{ root.submitCallModal() }}">Call</button>
              <button type="button"
                class="${k}_button ${k}_button-s ${k}_button-secondary"
                onclick="{{ root.closeCallModal() }}">Cancel</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  connectedCallback() {
    this.unsubscribeDecallLog = subscribeDecallLog((entry) => {
      this.appendConnectionLog(entry);
    });

    componentsRegistryService.connectBucket(this.innerBucket);
    this.innerBucket.setState("secretAuth", this.emptyAuthState());
    this.innerBucket.setValue("chatSpinner", SpinnerValue.inactive);
    super.connectedCallback();

    this.newRxFunc(() => {
      const loading = Boolean(this.inCall$.actual) && !this.chatConnected$.actual;
      this.innerBucket.setValue(
        "chatSpinner",
        loading ? SpinnerValue.active : SpinnerValue.inactive,
      );
    }, this.inCall$, this.chatConnected$);

    this.newRxFunc((state) => {
      this.updateCallIdentity(state);
    }, this.secretAuthState$);

    this.newRxFunc((hasIdentity) => {
      if (hasIdentity) {
        this.playAuthTransition();
        return;
      }
      this.resetAuthTransition();
    }, this.hasCallIdentity$);

    this.loadChallenge();
  }

  disconnectedCallback() {
    this.unsubscribeDecallLog?.();
    this.unsubscribeDecallLog = undefined;
    this.stopIdentityScramble?.();
    this.stopIdentityScramble = undefined;
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

  openCallModal() {
    this.joinCallId$.update("");
    this.callModalOpen$.update(true);
  }

  closeCallModal(event?: Event) {
    if (event && event.target !== event.currentTarget) return;
    this.callModalOpen$.update(false);
    this.joinCallId$.update("");
  }

  submitCallModal() {
    const roomId = (this.joinCallId$.actual ?? "").trim();
    if (!roomId) return;
    this.callModalOpen$.update(false);
    this.joinChatRoom();
  }

  sendChat() {
    this.chatSession?.send(this.chatDraft$.actual ?? "");
    this.chatDraft$.update("");
  }

  disconnectChat() {
    decallLog("session", "User left call");
    this.chatSession?.close();
    this.chatSession = null;
    this.chatStatus$.update("idle");
    this.connectionMode$.update("");
    this.chatConnected$.update(false);
    this.inCall$.update(false);

    const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement | null;
    if (remoteVideo) remoteVideo.srcObject = null;
  }

  private stopLocalMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    const localVideo = document.getElementById("localVideo") as HTMLVideoElement | null;
    if (localVideo) localVideo.srcObject = null;

    this.isAudioEnabled$.update(false);
    this.isVideoEnabled$.update(false);
  }

  private bindLocalPreview() {
    const localVideo = document.getElementById("localVideo") as HTMLVideoElement | null;
    if (localVideo) {
      localVideo.srcObject = this.localStream;
    }

    const audioTrack = this.localStream?.getAudioTracks()[0];
    const videoTrack = this.localStream?.getVideoTracks()[0];
    this.isAudioEnabled$.update(Boolean(audioTrack?.enabled));
    this.isVideoEnabled$.update(Boolean(videoTrack?.enabled));
  }

  private syncMediaCommand(kind: "AUDIO" | "VIDEO", enabled: boolean) {
    if (!this.inCall$.actual || !this.chatSession) return;
    this.chatSession.send(`CMD:${kind}:${enabled ? "ON" : "OFF"}`);
  }

  private async ensureMediaTrack(kind: "audio" | "video"): Promise<MediaStreamTrack | null> {
    const existing = kind === "audio"
      ? this.localStream?.getAudioTracks()[0]
      : this.localStream?.getVideoTracks()[0];
    if (existing) return existing;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: kind === "audio",
        video: kind === "video",
      });
      const track = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!track) return null;

      if (!this.localStream) {
        this.localStream = new MediaStream();
      }

      this.localStream.addTrack(track);
      stream.getTracks().filter((t) => t !== track).forEach((t) => t.stop());

      this.bindLocalPreview();

      if (this.chatSession && this.inCall$.actual) {
        this.chatSession.addLocalTrack(track, this.localStream);
      }

      return track;
    } catch (err) {
      decallLog("media", `Failed to enable ${kind}`, err, "error");
      return null;
    }
  }

  private async ensureLocalMedia() {
    if (this.localStream) {
      this.bindLocalPreview();
      return;
    }

    await this.startCamera();
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
    decallLog("media", "Requesting camera and microphone");
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      decallLog("media", "Camera and microphone granted");
    } catch (err) {
      decallLog("media", "Camera unavailable, trying audio only", err, "warn");

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true,
        });
        decallLog("media", "Microphone granted (audio only)");
      } catch (audioErr) {
        decallLog("media", "Microphone denied or unavailable", audioErr, "error");
        if (this.inCall$.actual) this.chatStatus$.update("media error");
        throw audioErr;
      }
    }

    this.bindLocalPreview();
  }

  toggleAudio() {
    void this.toggleAudioAsync();
  }

  private async toggleAudioAsync() {
    await this.ensureLocalMedia();
    if (!this.localStream) return;

    let audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) {
      if (this.isAudioEnabled$.actual) return;
      audioTrack = await this.ensureMediaTrack("audio") ?? undefined;
      if (!audioTrack) return;
      this.isAudioEnabled$.update(true);
      this.syncMediaCommand("AUDIO", true);
      return;
    }

    audioTrack.enabled = !audioTrack.enabled;
    this.isAudioEnabled$.update(audioTrack.enabled);
    this.syncMediaCommand("AUDIO", audioTrack.enabled);
  }

  toggleVideo() {
    void this.toggleVideoAsync();
  }

  private async toggleVideoAsync() {
    await this.ensureLocalMedia();
    if (!this.localStream) return;

    let videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) {
      if (this.isVideoEnabled$.actual) return;
      videoTrack = await this.ensureMediaTrack("video") ?? undefined;
      if (!videoTrack) return;
      this.isVideoEnabled$.update(true);
      this.syncMediaCommand("VIDEO", true);
      return;
    }

    videoTrack.enabled = !videoTrack.enabled;
    this.isVideoEnabled$.update(videoTrack.enabled);
    this.syncMediaCommand("VIDEO", videoTrack.enabled);
  }

  private async startChat(roomId: string, role: "host" | "guest") {
    this.disconnectChat();
    this.chatMessages = [];
    this.clearConnectionLog();
    this.template.detectChanges();
    this.inCall$.update(true);

    decallLog("session", `Starting call (${role})`, {
      roomId,
      apiBase: import.meta.env.VITE_API_BASE ?? "/api",
      online: navigator.onLine,
      userAgent: navigator.userAgent,
    });

    try {
      await this.ensureLocalMedia();
    } catch {
      this.inCall$.update(false);
      return;
    }

    const proof = this.secretAuthState$.actual?.proof;
    if (!proof) {
      this.inCall$.update(false);
      this.appendChatMessage({ from: "system", text: "Sign in before starting a call" });
      this.chatStatus$.update("error");
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
        this.chatConnected$.update(CHAT_CONNECTED_STATUSES.has(status));

        if (status === "chat ready" || status === "open" || status === "connected") {
          setTimeout(() => {
            this.chatSession?.send(`CMD:AUDIO:${this.isAudioEnabled$.actual ? "ON" : "OFF"}`);
            this.chatSession?.send(`CMD:VIDEO:${this.isVideoEnabled$.actual ? "ON" : "OFF"}`);
          }, 500);
        }
      },

      (mode) => {
        this.connectionMode$.update(mode === "p2p" ? "P2P" : mode === "turn" ? "TURN" : "");
      },

      this.localStream,

      (remoteStream) => {
        const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
        if (remoteVideo) {
          remoteVideo.srcObject = remoteStream;
        }
      },

      () => {
        const authState = this.secretAuthState$.actual;
        const passkey = authState?.passkey;
        return fetchTurnIceServers({
          proof,
          webauthn: passkey?.credentialPublicKey
            ? {
                credentialPublicKey: passkey.credentialPublicKey,
                expectedOrigin: window.location.origin,
              }
            : undefined,
        });
      },
    );

    const action = role === "host"
      ? this.chatSession.openRoom(roomId)
      : this.chatSession.joinRoom(roomId);

    action.catch((err: unknown) => {
      const text = err instanceof Error ? err.message : "chat connection failed";
      decallLog("session", "Call start failed", err, "error");
      this.appendChatMessage({ from: "system", text });
      this.chatStatus$.update("error");
    });
  }

  private appendConnectionLog(entry: Parameters<typeof formatDecallLogLine>[0]) {
    this.connectionLogLines = [...this.connectionLogLines, formatDecallLogLine(entry)];
    if (this.connectionLogLines.length > 200) {
      this.connectionLogLines = this.connectionLogLines.slice(-200);
    }
    this.connectionLogText$.update(this.connectionLogLines.join("\n"));
  }

  private clearConnectionLog() {
    this.connectionLogLines = [];
    this.connectionLogText$.update("");
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
      this.pendingIdentity = "";
      return;
    }

    const generation = ++this.identityGeneration;

    pubKeyToCallIdentity(pubKey).then((identity) => {
      if (generation !== this.identityGeneration) return;
      this.pendingIdentity = identity;
      this.callIdentity$.update(identity);
      this.hasCallIdentity$.update(true);
    });
  }

  private playAuthTransition() {
    if (this.authTransitionStarted) return;
    this.authTransitionStarted = true;

    this.authPanelExiting$.update(true);

    window.setTimeout(() => {
      this.authPanelExiting$.update(false);
      this.showAuthPanel$.update(false);
      this.showHeader$.update(false);

      this.showPostAuth$.update(true);
      this.postAuthEntering$.update(false);
      this.displayIdentity$.update("");
      this.template.detectChanges();

      requestAnimationFrame(() => {
        this.postAuthEntering$.update(true);
        this.startIdentityScramble(this.pendingIdentity);
        void this.ensureLocalMedia().catch(() => {});
      });
    }, EXIT_FADE_MS);
  }

  private startIdentityScramble(target: string) {
    this.stopIdentityScramble?.();
    if (!target) return;

    this.stopIdentityScramble = runIdentityScramble(
      target,
      (value) => this.displayIdentity$.update(value),
    );
  }

  private resetAuthTransition() {
    this.authTransitionStarted = false;
    this.pendingIdentity = "";
    this.stopIdentityScramble?.();
    this.stopIdentityScramble = undefined;
    this.stopLocalMedia();

    this.showAuthPanel$.update(true);
    this.showHeader$.update(true);
    this.showPostAuth$.update(false);
    this.authPanelExiting$.update(false);
    this.postAuthEntering$.update(false);
    this.displayIdentity$.update("");

    this.template.detectChanges();
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
