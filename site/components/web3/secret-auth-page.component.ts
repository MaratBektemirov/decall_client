import { MicrophoneIcon } from "site/icons/microphone";
import { MicrophoneOffIcon } from "site/icons/microphone-off";
import { VideoIcon } from "site/icons/video";
import { VideoOffIcon } from "site/icons/video-off";
import { CopyIcon } from "site/icons/copy";
import { CheckIcon } from "site/icons/check";
import styles from "./secret-auth-page.module.css";

import { AbstractComponent, componentsRegistryService, Rx, RxBucket } from "cruzo";
import { UI_KIT } from "cruzo/ui-components/const";
import { SpinnerComponent, SpinnerConfig, SpinnerValue } from "cruzo/ui-components/spinner";
import { SecretAuthComponent } from "cruzo-web3/components/secret-auth";
import type { SecretAuthState } from "cruzo-web3";
import { secretAuthService } from "cruzo-web3";
import type { SecretAuthMode } from "cruzo-web3";
import { formatSecretAuthChallenge } from "cruzo-web3/secret-auth";
import type { SecretAuthProof, SecretAuthPubKey } from "cruzo-web3/secret-auth";

import { fetchAuthChallenge } from "site/services/auth-api";
import { fetchTurnIceServers } from "site/services/ice-servers";
import { pubKeyToCallIdentity } from "site/utils/call-identity";
import {
  buildInviteLink,
  clearJoinFromUrl,
  parseJoinCallId,
} from "site/utils/invite-link";
import { runIdentityScramble } from "site/utils/identity-scramble";
import { decallLog, formatDecallLogLine, subscribeDecallLog } from "site/utils/decall-log";
import { ChatSession, type ChatMessage } from "site/webrtc/chat-session";

const EXIT_FADE_MS = 520;
const LOGO_SRC = `${import.meta.env.BASE_URL}logo.svg`;

const CHAT_CONNECTED_STATUSES = new Set(["chat ready", "open", "connected"]);

const STATUS_SPINNER_STATUSES = new Set([
  "connecting…",
  "negotiating…",
  "waiting for approval…",
  "waiting for host…",
]);

export class SecretAuthPageComponent extends AbstractComponent {
  static selector = "secret-auth-page-component";

  dependencies = new Set([
    SecretAuthComponent.selector,
    CopyIcon.selector,
    CheckIcon.selector,
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
  inviteLinkCopied$ = this.newRx(false);
  pendingJoinCallId$ = this.newRx("");
  showJoinPrompt$ = this.newRx(false);
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  isAudioEnabled$ = this.newRx(false);
  isVideoEnabled$ = this.newRx(false);
  // states for the remote user
  isRemoteAudioEnabled$ = this.newRx(false);
  isRemoteVideoEnabled$ = this.newRx(false);
  peerAudioMuted$ = this.newRx(false);
  peerVideoHidden$ = this.newRx(false);
  challengeLoading$ = this.newRx(false);
  challengeError$ = this.newRx("");

  joinCallId$ = this.newRx("");
  callModalOpen$ = this.newRx(false);
  joinRequestOpen$ = this.newRx(false);
  joinRequestCallId$ = this.newRx("");
  videoModalOpen$ = this.newRx(false);
  chatStatus$ = this.newRx("idle");
  connectionMode$ = this.newRx("");
  chatConnected$ = this.newRx(false);
  sessionRole$ = this.newRx<"host" | "guest">("host");
  statusSpinner$ = this.newRx(false);
  inCall$ = this.newRx(false);
  connectionLogText$ = this.newRx("");
  chatMessages: Rx<ChatMessage>[] = [];
  chatDraft$ = this.newRx("");
  peerTyping$ = this.newRx(false);

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
  private chatSessionGen = 0;
  private homeRoomActive = false;
  private authTransitionStarted = false;
  private pendingIdentity = "";
  private stopIdentityScramble?: () => void;
  private unsubscribeDecallLog?: () => void;
  private connectionLogLines: string[] = [];
  private typingStopTimer = 0;
  private peerTypingTimer = 0;
  private typingActive = false;

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

        <div class="${styles.callModalBackdrop}"
          attached="{{ root.showJoinPrompt$::rx && root.showAuthPanel$::rx }}">
          <div class="${styles.joinRequestModal}">
            <p class="${styles.joinRequestText}">
              You're invited to join a call.<br>
              Sign in with a one-time <strong>ephemeral</strong> key?
            </p>
            <div class="${styles.joinRequestActions}">
              <button type="button"
                class="${k}_button ${k}_button-s ${k}_button-primary"
                onclick="{{ root.chooseEphemeralJoin() }}">Ephemeral</button>
              <button type="button"
                class="${k}_button ${k}_button-s ${k}_button-secondary"
                onclick="{{ root.chooseOtherJoinMethod() }}">Choose method</button>
            </div>
          </div>
        </div>

        <div class="${styles.postAuth}" attached="{{ root.showPostAuth$::rx }}">
          <div class="${styles.postAuthInner} {{ root.postAuthEntering$::rx ? '${styles.postAuthEnter}' : '${styles.postAuthHidden}' }}">
            <div class="${styles.chatCard}">
              <div class="${styles.identityHead}">
                <img class="${styles.chatLogo}" src="${LOGO_SRC}" alt="Decall">
                <div class="${styles.chatHeadInfo}">
                  <div class="${styles.chatStatusBar}">
                    <div class="${styles.chatStatusGroup}">
                      <span class="${styles.chatStatus}">{{ root.chatStatus$::rx }}</span>
                      <div class="${styles.chatStatusSpinner}"
                        attached="{{ root.statusSpinner$::rx }}"
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
                  <div class="${styles.chatIdentityRow}">
                    <span class="${styles.chatIdentityId}">{{ root.displayIdentity$::rx }}</span>
                    <button type="button"
                      class="${styles.copyInviteButton}"
                      title="Copy invite link"
                      aria-label="Copy invite link"
                      onclick="{{ root.copyInviteLink() }}">
                      <copy-icon class="${styles.copyInviteIcon}"
                        attached="{{ !root.inviteLinkCopied$::rx }}"></copy-icon>
                      <check-icon class="${styles.copyInviteIcon} ${styles.copyInviteCheck}"
                        attached="{{ root.inviteLinkCopied$::rx }}"></check-icon>
                    </button>
                  </div>
                </div>
              </div>

              <div class="${styles.chatActions}">
                <button type="button"
                  class="${k}_button ${k}_button-s ${k}_button-primary"
                  attached="{{ root.sessionRole$::rx === 'host' && !root.chatConnected$::rx }}"
                  onclick="{{ root.openCallModal() }}">Call</button>
                <button type="button"
                  class="${k}_button ${k}_button-s ${k}_button-secondary"
                  attached="{{ root.sessionRole$::rx === 'guest' || root.chatConnected$::rx }}"
                  onclick="{{ root.disconnectChat() }}">Disconnect</button>
              </div>

              <div class="${styles.mediaControlsBar}" attached="{{ root.chatConnected$::rx }}">
                <div class="${styles.mediaGroup}">
                  <span class="${styles.mediaGroupLabel}">Peer</span>
                  <div class="${styles.mediaGroupButtons}">
                    <button type="button"
                      class="${styles.mediaButton} ${styles.mediaButtonPeer}"
                      aria-label="{{ root.peerAudioMuted$::rx ? 'Unmute peer audio' : 'Mute peer audio' }}"
                      onclick="{{ root.togglePeerAudio() }}">
                      <microphone-icon class="${styles.mediaIcon}" attached="{{ !root.peerAudioMuted$::rx }}"></microphone-icon>
                      <microphone-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ root.peerAudioMuted$::rx }}"></microphone-off-icon>
                    </button>
                    <button type="button"
                      class="${styles.mediaButton} ${styles.mediaButtonPeer}"
                      aria-label="{{ root.peerVideoHidden$::rx ? 'Show peer video' : 'Hide peer video' }}"
                      onclick="{{ root.togglePeerVideo() }}">
                      <video-icon class="${styles.mediaIcon}" attached="{{ !root.peerVideoHidden$::rx }}"></video-icon>
                      <video-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ root.peerVideoHidden$::rx }}"></video-off-icon>
                    </button>
                  </div>
                </div>
                <div class="${styles.mediaGroupDivider}" aria-hidden="true"></div>
                <div class="${styles.mediaGroup}">
                  <span class="${styles.mediaGroupLabel}">You</span>
                  <div class="${styles.mediaGroupButtons}">
                    <button type="button"
                      class="${styles.mediaButton} ${styles.mediaButtonSelf}"
                      aria-label="{{ root.isAudioEnabled$::rx ? 'Turn microphone off' : 'Turn microphone on' }}"
                      onclick="{{ root.toggleAudio() }}">
                      <microphone-icon class="${styles.mediaIcon}" attached="{{ root.isAudioEnabled$::rx }}"></microphone-icon>
                      <microphone-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ !root.isAudioEnabled$::rx }}"></microphone-off-icon>
                    </button>
                    <button type="button"
                      class="${styles.mediaButton} ${styles.mediaButtonSelf}"
                      aria-label="{{ root.isVideoEnabled$::rx ? 'Turn camera off' : 'Turn camera on' }}"
                      onclick="{{ root.toggleVideo() }}">
                      <video-icon class="${styles.mediaIcon}" attached="{{ root.isVideoEnabled$::rx }}"></video-icon>
                      <video-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ !root.isVideoEnabled$::rx }}"></video-off-icon>
                    </button>
                  </div>
                </div>
              </div>

              <div class="${styles.mediaControls}" attached="{{ !root.chatConnected$::rx }}">
                <button type="button"
                  class="${styles.mediaButton}"
                  aria-label="Open video"
                  onclick="{{ root.openVideoModal() }}">
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

              <button type="button"
                class="${styles.peerPreview}"
                attached="{{ root.chatConnected$::rx }}"
                aria-label="Open video"
                onclick="{{ root.openVideoModal() }}">
                <video id="remoteVideoPreview" class="${styles.peerPreviewVideo}" autoplay playsinline muted></video>
                <div class="${styles.peerPreviewPlaceholder}"
                  attached="{{ !root.isRemoteVideoEnabled$::rx || root.peerVideoHidden$::rx }}">
                  <span class="${styles.peerPreviewPlaceholderText}">
                    {{ root.peerVideoHidden$::rx ? 'Video hidden' : 'Camera off' }}
                  </span>
                </div>
                <span class="${styles.peerPreviewHint}">Tap to expand</span>
              </button>
              <audio id="remoteAudio" autoplay playsinline hidden attached="{{ root.inCall$::rx }}"></audio>

              <details class="${styles.connectionLog}" attached="{{ root.inCall$::rx }}">
                <summary class="${styles.connectionLogSummary}">Connection log</summary>
                <pre class="${styles.connectionLogPre}">{{ root.connectionLogText$::rx }}</pre>
              </details>

              <div class="${styles.chatMessenger}" attached="{{ root.chatConnected$::rx }}">
                <div class="${styles.messages}">
                  <div repeat="{{ root.chatMessages }}" class="${styles.messageRow}">
                    <div class="${styles.message} ${styles.messageMe}" attached="{{ this::rx.from === 'me' }}">{{ this::rx.text }}</div>
                    <div class="${styles.message} ${styles.messagePeer}" attached="{{ this::rx.from === 'peer' }}">{{ this::rx.text }}</div>
                    <div class="${styles.message} ${styles.messageSystem}" attached="{{ this::rx.from === 'system' }}">{{ this::rx.text }}</div>
                  </div>
                </div>

                <div class="${styles.typingRow}" attached="{{ root.peerTyping$::rx }}">
                  <div class="${styles.typingBubble}">
                    <span class="${styles.typingDot}"></span>
                    <span class="${styles.typingDot}"></span>
                    <span class="${styles.typingDot}"></span>
                  </div>
                </div>

                <div class="${styles.composeRow}">
                  <textarea
                    id="chatDraftInput"
                    class="${k}_textarea ${styles.chatInput}"
                    placeholder="Message"
                    value="{{ root.chatDraft$::rx }}"
                    oninput="{{ root.onChatInput(event.target.value) }}"></textarea>
                  <button type="button"
                    class="${k}_button ${k}_button-s ${k}_button-primary"
                    onclick="{{ root.sendChat() }}">Send</button>
                </div>
              </div>

              <div class="${styles.videoModalBackdrop}"
                attached="{{ root.videoModalOpen$::rx }}"
                onclick="{{ root.closeVideoModal(event) }}">
                <div class="${styles.videoStage}" onclick="event.stopPropagation()">
                  <video id="remoteVideo" class="${styles.remoteVideo}" autoplay playsinline muted></video>
                  <div class="${styles.remoteVideoPlaceholder}"
                    attached="{{ root.inCall$::rx && !root.chatConnected$::rx }}">
                    <span class="${styles.remoteVideoPlaceholderText}">Waiting for peer…</span>
                  </div>
                  <div class="${styles.remoteVideoPlaceholder}"
                    attached="{{ root.chatConnected$::rx && (!root.isRemoteVideoEnabled$::rx || root.peerVideoHidden$::rx) }}">
                    <span class="${styles.remoteVideoPlaceholderText}">{{ root.peerVideoHidden$::rx ? 'Video hidden' : 'Camera off' }}</span>
                  </div>

                  <div class="${styles.localPip}">
                    <video id="localVideo" class="${styles.localVideo}" autoplay playsinline muted></video>
                    <div class="${styles.localPipPlaceholder}" attached="{{ !root.isVideoEnabled$::rx }}">
                      <video-off-icon class="${styles.localPipPlaceholderIcon}"></video-off-icon>
                    </div>
                    <div class="${styles.pipBadges}">
                      <div class="${styles.videoBadge}" attached="{{ !root.isAudioEnabled$::rx }}">
                        <microphone-off-icon class="${styles.videoBadgeIcon}"></microphone-off-icon>
                      </div>
                    </div>
                  </div>

                  <div class="${styles.videoTopBar}">
                    <span class="${styles.videoStatus}">{{ root.chatStatus$::rx }}</span>
                    <button type="button"
                      class="${styles.videoCloseButton}"
                      aria-label="Close video"
                      onclick="{{ root.closeVideoModal() }}">✕</button>
                  </div>

                  <div class="${styles.videoControlsBar}">
                    <div class="${styles.mediaGroup}" attached="{{ root.chatConnected$::rx }}">
                      <span class="${styles.mediaGroupLabel} ${styles.mediaGroupLabelDark}">Peer</span>
                      <div class="${styles.mediaGroupButtons}">
                        <button type="button"
                          class="${styles.mediaButton} ${styles.mediaButtonDark} ${styles.mediaButtonPeerDark}"
                          aria-label="{{ root.peerAudioMuted$::rx ? 'Unmute peer audio' : 'Mute peer audio' }}"
                          onclick="{{ root.togglePeerAudio() }}">
                          <microphone-icon class="${styles.mediaIcon}" attached="{{ !root.peerAudioMuted$::rx }}"></microphone-icon>
                          <microphone-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ root.peerAudioMuted$::rx }}"></microphone-off-icon>
                        </button>
                        <button type="button"
                          class="${styles.mediaButton} ${styles.mediaButtonDark} ${styles.mediaButtonPeerDark}"
                          aria-label="{{ root.peerVideoHidden$::rx ? 'Show peer video' : 'Hide peer video' }}"
                          onclick="{{ root.togglePeerVideo() }}">
                          <video-icon class="${styles.mediaIcon}" attached="{{ !root.peerVideoHidden$::rx }}"></video-icon>
                          <video-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ root.peerVideoHidden$::rx }}"></video-off-icon>
                        </button>
                      </div>
                    </div>
                    <div class="${styles.mediaGroupDivider} ${styles.mediaGroupDividerDark}"
                      attached="{{ root.chatConnected$::rx }}"
                      aria-hidden="true"></div>
                    <div class="${styles.mediaGroup}">
                      <span class="${styles.mediaGroupLabel} ${styles.mediaGroupLabelDark}">You</span>
                      <div class="${styles.mediaGroupButtons}">
                        <button type="button"
                          class="${styles.mediaButton} ${styles.mediaButtonDark} ${styles.mediaButtonSelfDark}"
                          aria-label="{{ root.isAudioEnabled$::rx ? 'Turn microphone off' : 'Turn microphone on' }}"
                          onclick="{{ root.toggleAudio() }}">
                          <microphone-icon class="${styles.mediaIcon}" attached="{{ root.isAudioEnabled$::rx }}"></microphone-icon>
                          <microphone-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ !root.isAudioEnabled$::rx }}"></microphone-off-icon>
                        </button>
                        <button type="button"
                          class="${styles.mediaButton} ${styles.mediaButtonDark} ${styles.mediaButtonSelfDark}"
                          aria-label="{{ root.isVideoEnabled$::rx ? 'Turn camera off' : 'Turn camera on' }}"
                          onclick="{{ root.toggleVideo() }}">
                          <video-icon class="${styles.mediaIcon}" attached="{{ root.isVideoEnabled$::rx }}"></video-icon>
                          <video-off-icon class="${styles.mediaIcon} ${styles.mediaIconOff}" attached="{{ !root.isVideoEnabled$::rx }}"></video-off-icon>
                        </button>
                      </div>
                    </div>
                    <div class="${styles.mediaGroupDivider} ${styles.mediaGroupDividerDark}" aria-hidden="true"></div>
                    <button type="button"
                      class="${styles.mediaButton} ${styles.mediaButtonDanger}"
                      aria-label="Disconnect"
                      attached="{{ root.inCall$::rx }}"
                      onclick="{{ root.disconnectChat() }}">
                      <span class="${styles.disconnectIcon}"></span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="${styles.callModalBackdrop}"
          attached="{{ root.joinRequestOpen$::rx }}">
          <div class="${styles.joinRequestModal}">
            <p class="${styles.joinRequestText}">
              User <strong class="${styles.joinRequestId}">{{ root.joinRequestCallId$::rx }}</strong>
              wants to join your call.
            </p>
            <div class="${styles.joinRequestActions}">
              <button type="button"
                class="${k}_button ${k}_button-s ${k}_button-primary"
                onclick="{{ root.acceptJoinRequest() }}">Allow</button>
              <button type="button"
                class="${k}_button ${k}_button-s ${k}_button-secondary"
                onclick="{{ root.rejectJoinRequest() }}">Decline</button>
            </div>
          </div>
        </div>

        <div class="${styles.callModalBackdrop}"
          attached="{{ root.callModalOpen$::rx }}"
          onclick="{{ root.closeCallModal(event) }}">
          <div class="${styles.callModal}">
            <input type="text"
              id="joinCallInput"
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
    this.bootstrapInviteJoin();
    super.connectedCallback();

    this.newRxFunc(() => {
      const loading = Boolean(this.statusSpinner$.actual);
      this.innerBucket.setValue(
        "chatSpinner",
        loading ? SpinnerValue.active : SpinnerValue.inactive,
      );
    }, this.statusSpinner$);

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
    this.clearTypingTimers();
    this.endCall({ returnHome: false });
    super.disconnectedCallback();
  }

  refreshChallenge() {
    this.endCall({ returnHome: false });
    this.hasCallIdentity$.update(false);
    this.callIdentity$.update("");
    this.pendingJoinCallId$.update("");
    this.showJoinPrompt$.update(false);
    this.loadChallenge();
  }

  chooseEphemeralJoin() {
    this.applyJoinAuthMode("ephemeral");
    this.showJoinPrompt$.update(false);
    void this.signInEphemeralForInvite();
  }

  chooseOtherJoinMethod() {
    this.showJoinPrompt$.update(false);
  }

  copyInviteLink() {
    const callId = this.callIdentity$.actual;
    if (!callId) return;

    navigator.clipboard.writeText(buildInviteLink(callId))
      .then(() => {
        this.inviteLinkCopied$.update(true);
        setTimeout(() => {
          this.inviteLinkCopied$.update(false);
        }, 2000);
      })
      .catch((err) => {
        console.error("Failed to copy invite link: ", err);
      });
  }

  private bootstrapInviteJoin() {
    const joinId = parseJoinCallId();
    if (!joinId) return;

    this.pendingJoinCallId$.update(joinId);
    this.showJoinPrompt$.update(true);
    decallLog("session", "Invite link detected", { joinId });
  }

  private applyJoinAuthMode(mode: SecretAuthMode) {
    secretAuthService.setMode(mode);

    const state = this.innerBucket.getState("secretAuth") as SecretAuthState | undefined;
    if (!state) return;

    this.innerBucket.setState("secretAuth", {
      ...state,
      mode,
    });
  }

  private buildEphemeralProof(
    message: string,
    signature: string,
    pubKey: SecretAuthPubKey,
  ): SecretAuthProof {
    return {
      message,
      signature: { value: signature },
      pubKey,
    };
  }

  private waitForAuthChallenge(timeoutMs = 15000): Promise<NonNullable<SecretAuthState["challenge"]>> {
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const tick = () => {
        const state = this.innerBucket.getState("secretAuth") as SecretAuthState | undefined;

        if (state?.challenge) {
          resolve(state.challenge);
          return;
        }

        const error = this.challengeError$.actual;
        if (error) {
          reject(new Error(error));
          return;
        }

        if (!this.challengeLoading$.actual && Date.now() - started > 500) {
          reject(new Error("Challenge is not available"));
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          reject(new Error("Challenge request timed out"));
          return;
        }

        window.requestAnimationFrame(tick);
      };

      tick();
    });
  }

  private async signInEphemeralForInvite() {
    const joinId = (this.pendingJoinCallId$.actual ?? "").trim();
    if (!joinId) return;

    if (this.secretAuthState$.actual?.signed) {
      const pendingJoin = this.consumePendingJoinCallId();
      if (pendingJoin) void this.startChat(pendingJoin, "guest");
      return;
    }

    try {
      const challenge = await this.waitForAuthChallenge();
      const state = this.innerBucket.getState("secretAuth") as SecretAuthState | undefined;
      if (!state) throw new Error("Auth state is not ready");

      const message = formatSecretAuthChallenge(challenge);
      const { pubKey, signature, publicKey } = await secretAuthService.signEphemeral(message);
      const proof = this.buildEphemeralProof(message, signature, pubKey);

      this.innerBucket.setState("secretAuth", {
        ...state,
        proof,
        signed: true,
        pubKey: publicKey,
        mode: "ephemeral",
        wallet: null,
        passkey: null,
      });

      decallLog("session", "Ephemeral sign-in for invite link", { joinId });
    } catch (err) {
      const text = err instanceof Error ? err.message : "Ephemeral sign-in failed";
      decallLog("session", "Ephemeral invite sign-in failed", err, "error");
      this.challengeError$.update(text);
      this.showJoinPrompt$.update(true);
    }
  }

  private consumePendingJoinCallId() {
    const joinId = (this.pendingJoinCallId$.actual ?? "").trim();
    this.pendingJoinCallId$.update("");
    clearJoinFromUrl();
    return joinId;
  }

  private openHomeRoom() {
    const roomId = this.callIdentity$.actual;
    if (!roomId || !this.secretAuthState$.actual?.signed) return;
    if (this.homeRoomActive && this.sessionRole$.actual === "host") return;

    void this.startChat(roomId, "host");
  }

  joinChatRoom() {
    const roomId = (this.joinCallId$.actual ?? "").trim();
    if (!roomId) return;

    const ownId = this.callIdentity$.actual;
    if (ownId && this.normalizeRoomId(roomId) === this.normalizeRoomId(ownId)) {
      this.appendChatMessage({
        from: "system",
        text: "That's your Call ID — share it so others can call you.",
      });
      return;
    }

    void this.startChat(roomId, "guest");
  }

  openCallModal() {
    this.joinCallId$.update("");
    this.callModalOpen$.update(true);

    this.template.detectChanges();

    requestAnimationFrame(() => {
      const input = document.getElementById("joinCallInput") as HTMLInputElement | null;
      if (input) {
        input.value = "";
      }
    });
  }

  closeCallModal(event?: Event) {
    if (event && event.target !== event.currentTarget) return;
    this.callModalOpen$.update(false);
    this.joinCallId$.update("");

    const input = document.getElementById("joinCallInput") as HTMLInputElement | null;
    if (input) {
      input.value = "";
    }
  }

  submitCallModal() {
    const roomId = (this.joinCallId$.actual ?? "").trim();
    if (!roomId) return;

    const input = document.getElementById("joinCallInput") as HTMLInputElement | null;
    if (input) {
      input.value = "";
    }

    this.callModalOpen$.update(false);
    this.joinChatRoom();
  }

  acceptJoinRequest() {
    this.chatSession?.acceptJoinRequest();
    this.joinRequestOpen$.update(false);
  }

  rejectJoinRequest() {
    this.chatSession?.rejectJoinRequest();
    this.joinRequestOpen$.update(false);
  }

  sendChat() {
    this.stopTypingNotify();

    const text = this.chatDraft$.actual ?? "";
    if (!text.trim()) return; // Small protection: don't send empty messages

    this.chatSession?.send(text);
    this.chatDraft$.update("");

    const input = document.getElementById("chatDraftInput") as HTMLTextAreaElement | null;
    if (input) {
      input.value = "";
    }
  }

  onChatInput(value: string) {
    this.chatDraft$.update(value);
    if (!this.chatConnected$.actual || !this.chatSession) return;

    if (value.trim()) {
      this.startTypingNotify();
    } else {
      this.stopTypingNotify();
    }
  }

  private startTypingNotify() {
    if (!this.typingActive) {
      this.chatSession?.send("CMD:TYPING:ON");
      this.typingActive = true;
    }

    window.clearTimeout(this.typingStopTimer);
    this.typingStopTimer = window.setTimeout(() => {
      this.stopTypingNotify();
    }, 2000);
  }

  private stopTypingNotify() {
    window.clearTimeout(this.typingStopTimer);
    this.typingStopTimer = 0;
    if (!this.typingActive) return;
    this.chatSession?.send("CMD:TYPING:OFF");
    this.typingActive = false;
  }

  private setPeerTyping(active: boolean) {
    this.peerTyping$.update(active);
    window.clearTimeout(this.peerTypingTimer);
    this.peerTypingTimer = 0;

    if (active) {
      this.peerTypingTimer = window.setTimeout(() => {
        this.peerTyping$.update(false);
      }, 3000);
    }
  }

  private clearTypingTimers() {
    this.stopTypingNotify();
    window.clearTimeout(this.peerTypingTimer);
    this.peerTypingTimer = 0;
    this.peerTyping$.update(false);
  }

  private clearCallUi() {
    this.closeVideoModal();
    this.joinRequestOpen$.update(false);
    this.joinRequestCallId$.update("");
    this.clearTypingTimers();
    this.chatConnected$.update(false);
    this.connectionMode$.update("");
    this.isRemoteAudioEnabled$.update(false);
    this.isRemoteVideoEnabled$.update(false);
    this.peerAudioMuted$.update(false);
    this.peerVideoHidden$.update(false);
    this.chatDraft$.update("");

    // Forcibly clear the DOM on exit
    const draftInput = document.getElementById("chatDraftInput") as HTMLTextAreaElement | null;
    if (draftInput) {
      draftInput.value = "";
    }

    const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement | null;
    if (remoteVideo) remoteVideo.srcObject = null;

    const remotePreview = document.getElementById("remoteVideoPreview") as HTMLVideoElement | null;
    if (remotePreview) remotePreview.srcObject = null;

    const remoteAudio = document.getElementById("remoteAudio") as HTMLAudioElement | null;
    if (remoteAudio) remoteAudio.srcObject = null;

    this.remoteStream = null;

    const localVideo = document.getElementById("localVideo") as HTMLVideoElement | null;
    if (localVideo) localVideo.srcObject = null;
  }

  private endCall(options: { returnHome?: boolean } = {}) {
    const returnHome = options.returnHome ?? true;
    const signedIn = Boolean(this.secretAuthState$.actual?.signed);
    const ownRoomId = this.callIdentity$.actual;

    if (!this.inCall$.actual && !this.chatSession) {
      if (returnHome && signedIn && ownRoomId) {
        this.openHomeRoom();
      }
      return;
    }

    this.teardownSession();
    this.chatStatus$.update("idle");
    this.inCall$.update(false);
    this.statusSpinner$.update(false);
    this.sessionRole$.update("host");

    if (returnHome && signedIn && ownRoomId) {
      this.openHomeRoom();
    }
  }

  disconnectChat() {
    decallLog("session", "User disconnected call");
    this.endCall({ returnHome: true });
  }

  openVideoModal() {
    this.videoModalOpen$.update(true);
    this.template.detectChanges();
    requestAnimationFrame(() => this.bindVideoElements());
  }

  closeVideoModal(event?: Event) {
    if (event && event.target !== event.currentTarget) return;
    this.videoModalOpen$.update(false);
  }

  private bindVideoElements() {
    const localVideo = document.getElementById("localVideo") as HTMLVideoElement | null;
    if (localVideo && this.localStream) {
      localVideo.srcObject = this.localStream;
    }

    this.bindRemoteMedia();
  }

  private bindRemoteMedia() {
    const stream = this.remoteStream;
    const preview = document.getElementById("remoteVideoPreview") as HTMLVideoElement | null;
    const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement | null;
    const remoteAudio = document.getElementById("remoteAudio") as HTMLAudioElement | null;

    for (const el of [preview, remoteVideo]) {
      if (!el) continue;
      el.srcObject = stream;
      if (stream) void el.play().catch(() => {});
    }

    if (remoteAudio) {
      remoteAudio.srcObject = stream;
      if (stream) void remoteAudio.play().catch(() => {});
    }

    this.applyRemoteMediaPlayback();
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
    this.bindVideoElements();
    this.isAudioEnabled$.update(Boolean(this.localStream?.getAudioTracks()[0]?.enabled));
    this.isVideoEnabled$.update(Boolean(this.localStream?.getVideoTracks()[0]?.enabled));
  }

  private syncMediaCommand(kind: "AUDIO" | "VIDEO", enabled: boolean) {
    if (!this.inCall$.actual || !this.chatSession) return;
    this.chatSession.send(`CMD:${kind}:${enabled ? "ON" : "OFF"}`);
  }

  private async ensureMediaTrack(kind: "audio" | "video", enable = true): Promise<MediaStreamTrack | null> {
    const existing = kind === "audio"
      ? this.localStream?.getAudioTracks()[0]
      : this.localStream?.getVideoTracks()[0];
    if (existing) {
      existing.enabled = enable;
      return existing;
    }

    if (!enable) return null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: kind === "audio",
        video: kind === "video",
      });
      const track = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!track) return null;

      track.enabled = true;

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
    if (this.localStream?.getTracks().length) {
      this.bindLocalPreview();
      return;
    }

    decallLog("media", "Requesting camera and microphone");

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      decallLog("media", "Camera and microphone granted");
      this.bindLocalPreview();
      return;
    } catch (err) {
      decallLog("media", "Camera unavailable, trying audio only", err, "warn");
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      decallLog("media", "Microphone granted (audio only)");
      this.bindLocalPreview();
    } catch (audioErr) {
      decallLog("media", "Microphone denied or unavailable", audioErr, "error");
      throw audioErr;
    }
  }

  toggleAudio() {
    void this.toggleAudioAsync();
  }

  togglePeerAudio() {
    this.peerAudioMuted$.update(!this.peerAudioMuted$.actual);
    this.applyRemoteMediaPlayback();
  }

  togglePeerVideo() {
    this.peerVideoHidden$.update(!this.peerVideoHidden$.actual);
    this.template.detectChanges();
  }

  private applyRemoteMediaPlayback() {
    const remoteAudio = document.getElementById("remoteAudio") as HTMLAudioElement | null;
    if (remoteAudio) {
      remoteAudio.muted = this.peerAudioMuted$.actual;
    }
  }

  private async toggleAudioAsync() {
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (!audioTrack) {
      if (this.isAudioEnabled$.actual) return;
      const track = await this.ensureMediaTrack("audio", true);
      if (!track) return;
      this.isAudioEnabled$.update(true);
      this.syncMediaCommand("AUDIO", true);
      return;
    }

    const next = !audioTrack.enabled;
    audioTrack.enabled = next;
    this.isAudioEnabled$.update(next);
    this.syncMediaCommand("AUDIO", next);
  }

  toggleVideo() {
    void this.toggleVideoAsync();
  }

  private async toggleVideoAsync() {
    if (!this.videoModalOpen$.actual) {
      this.openVideoModal();
    }

    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (!videoTrack) {
      if (this.isVideoEnabled$.actual) return;
      const track = await this.ensureMediaTrack("video", true);
      if (!track) return;
      this.isVideoEnabled$.update(true);
      this.syncMediaCommand("VIDEO", true);
      return;
    }

    const next = !videoTrack.enabled;
    videoTrack.enabled = next;
    this.isVideoEnabled$.update(next);
    this.syncMediaCommand("VIDEO", next);
  }

  private teardownSession() {
    this.chatSessionGen += 1;
    this.clearCallUi();
    this.stopLocalMedia();
    this.chatSession?.close();
    this.chatSession = null;
    this.homeRoomActive = false;
  }

  private normalizeRoomId(id: string) {
    return id.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
  }

  private async startChat(roomId: string, role: "host" | "guest") {
    this.teardownSession();
    this.chatMessages = [];
    this.clearConnectionLog();
    this.template.detectChanges();
    this.sessionRole$.update(role);
    this.inCall$.update(true);
    this.statusSpinner$.update(true);

    decallLog("session", `Starting call (${role})`, {
      roomId,
      apiBase: import.meta.env.VITE_API_BASE ?? "/api",
      online: navigator.onLine,
      userAgent: navigator.userAgent,
    });

    const proof = this.secretAuthState$.actual?.proof;
    if (!proof) {
      this.inCall$.update(false);
      this.appendChatMessage({ from: "system", text: "Sign in before starting a call" });
      this.chatStatus$.update("error");
      return;
    }

    const selfCallId = this.callIdentity$.actual ?? "";
    const sessionGen = ++this.chatSessionGen;

    this.chatSession = new ChatSession(
      (message) => {
        if (sessionGen !== this.chatSessionGen) return;

        if (message.text.startsWith("CMD:")) {

          if (message.from === "peer") {
            const parts = message.text.split(":");
            if (parts[1] === "AUDIO") this.isRemoteAudioEnabled$.update(parts[2] === "ON");
            if (parts[1] === "VIDEO") this.isRemoteVideoEnabled$.update(parts[2] === "ON");
            if (parts[1] === "TYPING") this.setPeerTyping(parts[2] === "ON");
          }
          return;
        }

        this.appendChatMessage(message);
      },

        (status) => {
        if (sessionGen !== this.chatSessionGen) return;

        this.chatStatus$.update(status);
        this.chatConnected$.update(CHAT_CONNECTED_STATUSES.has(status));
        this.statusSpinner$.update(STATUS_SPINNER_STATUSES.has(status));

        if (status === "waiting for peer…") {
          this.joinRequestOpen$.update(false);
          if (this.sessionRole$.actual === "host") {
            this.homeRoomActive = true;
          }
        }

        if (status === "idle") {
          this.endCall({ returnHome: true });
        }

        if (status === "chat ready" || status === "open" || status === "connected") {
          setTimeout(() => {
            this.chatSession?.send(`CMD:AUDIO:${this.isAudioEnabled$.actual ? "ON" : "OFF"}`);
            this.chatSession?.send(`CMD:VIDEO:${this.isVideoEnabled$.actual ? "ON" : "OFF"}`);
          }, 500);
        }
      },

      (mode) => {
        if (sessionGen !== this.chatSessionGen) return;
        this.connectionMode$.update(mode === "p2p" ? "P2P" : mode === "turn" ? "TURN" : "");
      },

      (callId) => {
        if (sessionGen !== this.chatSessionGen) return;
        this.joinRequestCallId$.update(callId || "unknown");
        this.joinRequestOpen$.update(true);
      },

      this.localStream,

      (remoteStream) => {
        if (sessionGen !== this.chatSessionGen) return;

        if (!this.remoteStream) {
          this.remoteStream = remoteStream;
        } else if (this.remoteStream.id !== remoteStream.id) {
          for (const track of remoteStream.getTracks()) {
            const exists = this.remoteStream.getTracks().some((t) => t.id === track.id);
            if (!exists) this.remoteStream.addTrack(track);
          }
        }

        this.template.detectChanges();
        requestAnimationFrame(() => this.bindRemoteMedia());
        this.isRemoteVideoEnabled$.update(this.remoteStream.getVideoTracks().some((t) => t.enabled));
        this.isRemoteAudioEnabled$.update(this.remoteStream.getAudioTracks().some((t) => t.enabled));
      },

      () => {
        if (sessionGen !== this.chatSessionGen) return;
        this.remoteStream = null;
        const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement | null;
        if (remoteVideo) remoteVideo.srcObject = null;
        const remotePreview = document.getElementById("remoteVideoPreview") as HTMLVideoElement | null;
        if (remotePreview) remotePreview.srcObject = null;
        const remoteAudio = document.getElementById("remoteAudio") as HTMLAudioElement | null;
        if (remoteAudio) remoteAudio.srcObject = null;
        this.isRemoteVideoEnabled$.update(false);
        this.isRemoteAudioEnabled$.update(false);
      },

      () => {
        if (sessionGen !== this.chatSessionGen) return;
        this.endCall({ returnHome: true });
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

      selfCallId,
    );

    const action = role === "host"
      ? this.chatSession.openRoom(roomId)
      : this.chatSession.joinRoom(roomId);

    action
      .then(() => {
        if (role === "host") {
          this.homeRoomActive = true;
        }
      })
      .catch((err: unknown) => {
      const text = err instanceof Error ? err.message : "chat connection failed";
      decallLog("session", "Call start failed", err, "error");
      this.appendChatMessage({ from: "system", text });
      this.chatStatus$.update("error");
      this.statusSpinner$.update(false);
      this.inCall$.update(false);

      if (role === "guest") {
        this.openHomeRoom();
      }
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

        const pendingJoin = this.consumePendingJoinCallId();
        if (pendingJoin) {
          const ownId = this.callIdentity$.actual;
          if (ownId && this.normalizeRoomId(pendingJoin) === this.normalizeRoomId(ownId)) {
            this.appendChatMessage({
              from: "system",
              text: "Invite link points to your own Call ID — waiting for others instead.",
            });
            this.openHomeRoom();
            return;
          }

          void this.startChat(pendingJoin, "guest");
          return;
        }

        this.openHomeRoom();
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
