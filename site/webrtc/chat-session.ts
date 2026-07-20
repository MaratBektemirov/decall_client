import { signalWebSocketUrl } from "site/services/signal-url";
import {
  decallLog,
  describeWebSocketClose,
  hintForIceFailure,
  hintForSignalFailure,
  iceCandidateType,
} from "site/utils/decall-log";
import { detectIceTransportMode, type IceTransportMode } from "site/utils/ice-transport";

export type ChatMessage = {
  from: "me" | "peer" | "system";
  text: string;
};

type SignalMessage = {
  type: string;
  role?: string;
  callId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  message?: string;
};

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

let sessionCounter = 0;

export class ChatSession {
  private readonly sessionId: string;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket | null = null;
  private roomId = "";
  private role: "host" | "guest" = "guest";
  private pendingIce: RTCIceCandidateInit[] = [];
  private iceCandidateTypes = new Set<string>();
  private transportMode: IceTransportMode | null = null;
  private transportCheckTimer = 0;
  private transportCheckAttempts = 0;
  private closed = false;
  private connectionGen = 0;
  private iceServers: RTCIceServer[] = FALLBACK_ICE_SERVERS;

  constructor(
    private onMessage: (msg: ChatMessage) => void,
    private onStatus: (status: string) => void,
    private onTransportMode: (mode: IceTransportMode | "") => void,
    private onJoinRequest: (callId: string) => void,
    private localStream: MediaStream | null,
    private onRemoteStream: (stream: MediaStream) => void,
    private onRemoteCleared: () => void,
    private onCallEnded: () => void,
    private resolveIceServers: () => Promise<RTCIceServer[]>,
    private selfCallId: string,
  ) {
    sessionCounter += 1;
    this.sessionId = `s${sessionCounter}`;
    this.log("session", "ChatSession created");
  }

  async openRoom(roomId: string) {
    this.log("session", `Open room as host`, { roomId });
    await this.connect(roomId, "host");
  }

  async joinRoom(roomId: string) {
    this.log("session", `Join room as guest`, { roomId });
    await this.connect(roomId, "guest");
  }

  send(text: string) {
    const value = text.trim();
    if (!value || !this.dc || this.dc.readyState !== "open") {
      this.log("webrtc", "Send skipped — data channel not open", {
        state: this.dc?.readyState ?? "none",
      }, "warn");
      return;
    }

    this.dc.send(value);
    this.onMessage({ from: "me", text: value });
  }

  addLocalTrack(track: MediaStreamTrack, stream: MediaStream) {
    if (!this.pc || this.closed) return;

    this.pc.addTrack(track, stream);
    this.log("media", `Local track added during call (${track.kind})`);
    void this.renegotiate();
  }

  close() {
    const hadResources = Boolean(this.ws || this.pc || this.dc);
    if (this.closed && !hadResources) return;

    this.connectionGen += 1;
    this.closed = true;
    if (hadResources) this.log("session", "Closing session");
    this.teardownPeerConnection();
    this.ws?.close();
    this.ws = null;
    this.roomId = "";
    this.role = "guest";
  }

  private endCall(reason: string) {
    if (this.closed) return;
    this.log("session", `Call ended (${reason})`);
    this.onStatus("idle");
    this.close();
    this.onCallEnded();
  }

  private log(
    category: Parameters<typeof decallLog>[0],
    message: string,
    detail?: unknown,
    level: Parameters<typeof decallLog>[3] = "info",
  ) {
    decallLog(category, `[${this.sessionId}] ${message}`, detail, level);
  }

  private async connect(roomId: string, role: "host" | "guest") {
    this.close();
    this.closed = false;
    const gen = ++this.connectionGen;

    this.roomId = roomId;
    this.role = role;
    this.onStatus("connecting…");

    const signalUrl = signalWebSocketUrl();
    this.log("signal", "Connecting WebSocket", { url: signalUrl, role, roomId });

    const ws = new WebSocket(signalUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (gen !== this.connectionGen) return;
      this.log("signal", "WebSocket open");
    });

    ws.addEventListener("error", () => {
      if (gen !== this.connectionGen) return;
      this.log("signal", "WebSocket error", hintForSignalFailure(), "error");
    });

    ws.addEventListener("close", (event) => {
      if (gen !== this.connectionGen) return;
      const hint = describeWebSocketClose(event.code, event.reason);
      this.log("signal", "WebSocket closed", { code: event.code, reason: event.reason, hint }, "warn");
      if (!this.closed) {
        this.closed = true;
        this.teardownPeerConnection();
        this.ws = null;
        this.roomId = "";
        this.onStatus("idle");
        this.onCallEnded();
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => {
          reject(new Error("signal connection failed"));
        }, { once: true });
      });
    } catch (err) {
      if (gen !== this.connectionGen) return;
      this.log("signal", "WebSocket connect failed", err, "error");
      throw err;
    }

    if (gen !== this.connectionGen) return;

    try {
      this.iceServers = await this.resolveIceServers();
    } catch (err) {
      this.log("api", "Failed to load TURN credentials, using STUN fallback", err, "warn");
      this.iceServers = FALLBACK_ICE_SERVERS;
    }

    if (gen !== this.connectionGen) return;

    this.setupPeerConnection(gen);

    ws.addEventListener("message", (event) => {
      if (gen !== this.connectionGen) return;
      let payload: SignalMessage;
      try {
        payload = JSON.parse(String(event.data)) as SignalMessage;
      } catch (err) {
        this.log("signal", "Invalid signal JSON", err, "error");
        return;
      }

      this.log("signal", `← ${payload.type}`, this.sanitizeSignalForLog(payload));
      void this.handleSignal(payload).catch((err: unknown) => {
        if (gen !== this.connectionGen) return;
        const text = err instanceof Error ? err.message : "signaling error";
        this.log("signal", "Signal handler error", err, "error");
        this.onStatus("error");
        this.onMessage({ from: "system", text });
      });
    });

    this.sendSignal({ type: "join", roomId, role, callId: this.selfCallId });
    this.log("signal", "→ join", { roomId, role, callId: this.selfCallId });
  }

  private teardownPeerConnection() {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.ondatachannel = null;
      this.pc.close();
      this.pc = null;
    }

    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onclose = null;
      this.dc.onerror = null;
      this.dc.onmessage = null;
      this.dc.close();
      this.dc = null;
    }

    this.pendingIce = [];
    this.iceCandidateTypes.clear();
    this.stopTransportMonitoring();
    this.transportMode = null;
    this.onTransportMode("");
    this.onRemoteCleared();
  }

  private setupPeerConnection(gen: number) {
    this.teardownPeerConnection();
    if (this.closed || gen !== this.connectionGen) return;

    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.log("webrtc", "RTCPeerConnection created", {
      iceServers: this.iceServers.map((server) => ({
        urls: server.urls,
        hasCredential: Boolean(server.username && server.credential),
      })),
    });

    if (this.localStream) {
      const tracks = this.localStream.getTracks().map((t) => `${t.kind}:${t.label}`);
      this.log("media", "Adding local tracks", tracks);
      this.localStream.getTracks().forEach((track) => {
        this.pc?.addTrack(track, this.localStream!);
      });
    } else {
      this.log("media", "No local media stream", null, "warn");
    }

    this.pc.ontrack = (event) => {
      if (gen !== this.connectionGen) return;
      const stream = event.streams?.[0] ?? new MediaStream([event.track]);
      this.log("webrtc", "Remote track received", {
        kind: event.track.kind,
        streamId: stream?.id,
        trackCount: stream?.getTracks().length,
      });
      this.onRemoteStream(stream);
    };

    this.pc.onicecandidate = (event) => {
      if (gen !== this.connectionGen) return;
      if (!event.candidate) {
        this.log("ice", "ICE gathering complete", {
          types: [...this.iceCandidateTypes],
          pendingBuffered: this.pendingIce.length,
        });
        return;
      }

      const type = iceCandidateType(event.candidate.toJSON());
      this.iceCandidateTypes.add(type);
      this.log("ice", `Local ICE candidate (${type})`, event.candidate.candidate);
      this.sendSignal({
        type: "ice",
        candidate: event.candidate.toJSON(),
      });
    };

    this.pc.onicegatheringstatechange = () => {
      if (gen !== this.connectionGen) return;
      this.log("ice", `ICE gathering: ${this.pc?.iceGatheringState ?? "unknown"}`);
    };

    this.pc.oniceconnectionstatechange = () => {
      if (gen !== this.connectionGen) return;
      const state = this.pc?.iceConnectionState ?? "unknown";
      this.log("ice", `ICE connection: ${state}`);

      if (state === "failed") {
        this.log("ice", hintForIceFailure(), {
          gatheredTypes: [...this.iceCandidateTypes],
        }, "error");
        this.onMessage({ from: "system", text: hintForIceFailure() });
      }

      if (state === "disconnected") {
        this.log("ice", "ICE disconnected — peer may be unreachable or UDP blocked", null, "warn");
      }
    };

    this.pc.onsignalingstatechange = () => {
      if (gen !== this.connectionGen) return;
      this.log("webrtc", `Signaling state: ${this.pc?.signalingState ?? "unknown"}`);
    };

    this.pc.onconnectionstatechange = () => {
      if (gen !== this.connectionGen) return;
      const state = this.pc?.connectionState ?? "closed";
      this.log("webrtc", `Connection state: ${state}`);

      if (state === "connected") {
        this.onStatus("connected");
        this.startTransportMonitoring();
        return;
      }

      if (state === "failed") {
        this.log("webrtc", "Peer connection failed", hintForIceFailure(), "error");
        this.onMessage({ from: "system", text: hintForIceFailure() });
        this.endCall("connection-failed");
        return;
      }

      if (state === "disconnected" || state === "closed") {
        this.onStatus("disconnected");
      }
    };

    if (this.role === "host") {
      const channel = this.pc.createDataChannel("chat");
      this.log("webrtc", "Data channel created (host)");
      this.wireDataChannel(channel, gen);
    } else {
      this.pc.ondatachannel = (event) => {
        if (gen !== this.connectionGen) return;
        this.log("webrtc", "Data channel received (guest)");
        this.wireDataChannel(event.channel, gen);
      };
    }
  }

  private async resetForNewPeer() {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.log("session", "Resetting peer connection for new peer");
    this.teardownPeerConnection();

    try {
      this.iceServers = await this.resolveIceServers();
    } catch (err) {
      this.log("api", "Failed to refresh TURN credentials, reusing previous ICE servers", err, "warn");
    }

    this.setupPeerConnection(this.connectionGen);
  }

  acceptJoinRequest() {
    this.sendSignal({ type: "accept-guest" });
    this.log("signal", "→ accept-guest");
  }

  rejectJoinRequest() {
    this.sendSignal({ type: "reject-guest" });
    this.log("signal", "→ reject-guest");
  }

  private sanitizeSignalForLog(message: SignalMessage): Record<string, unknown> {
    if (message.type === "ice") {
      return {
        type: message.type,
        candidateType: message.candidate ? iceCandidateType(message.candidate) : null,
      };
    }
    if (message.type === "offer" || message.type === "answer") {
      return { type: message.type, sdpBytes: message.sdp?.length ?? 0 };
    }
    return { type: message.type, role: message.role, message: message.message };
  }

  private wireDataChannel(channel: RTCDataChannel, gen: number) {
    this.dc = channel;

    channel.onopen = () => {
      if (gen !== this.connectionGen) return;
      this.log("webrtc", "Data channel open");
      this.onStatus("chat ready");
    };

    channel.onclose = () => {
      if (gen !== this.connectionGen) return;
      this.log("webrtc", "Data channel closed", null, "warn");
    };

    channel.onerror = () => {
      if (gen !== this.connectionGen) return;
      this.log("webrtc", "Data channel error", null, "error");
    };

    channel.onmessage = (event) => {
      if (gen !== this.connectionGen) return;
      this.onMessage({ from: "peer", text: String(event.data) });
    };
  }

  private async handleSignal(message: SignalMessage) {
    switch (message.type) {
      case "peer-left":
        this.onMessage({
          from: "system",
          text: message.message ?? "Other participant disconnected",
        });
        this.endCall("peer-left");
        return;
      case "join-rejected":
        this.onStatus("call declined");
        this.onMessage({ from: "system", text: message.message ?? "Host declined your request" });
        this.endCall("join-rejected");
        return;
      case "error":
        this.onStatus("error");
        this.log("signal", "Server error", message.message, "error");
        this.onMessage({ from: "system", text: message.message ?? "error" });
        return;
    }

    if (!this.pc) return;

    switch (message.type) {
      case "joined":
        this.onStatus(message.role === "host" ? "waiting for peer…" : "waiting for host…");
        break;
      case "waiting":
        this.onStatus("waiting for peer…");
        break;
      case "waiting-approval":
        this.onStatus("waiting for approval…");
        break;
      case "join-request":
        if (message.callId) {
          this.onJoinRequest(message.callId);
        }
        this.onStatus("incoming request…");
        break;
      case "peer-joined":
        this.onStatus("negotiating…");
        if (!this.pc) {
          await this.resetForNewPeer();
        }
        if (this.role === "host") {
          await this.createOffer();
        }
        break;
      case "offer":
        if (!message.sdp) return;
        await this.pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
        await this.flushPendingIce();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({ type: "answer", sdp: answer.sdp ?? "" });
        this.log("signal", "→ answer", { sdpBytes: answer.sdp?.length ?? 0 });
        break;
      case "answer":
        if (!message.sdp) return;
        await this.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        await this.flushPendingIce();
        break;
      case "ice":
        if (!message.candidate) return;
        await this.addIceCandidate(message.candidate);
        break;
    }
  }

  private async createOffer() {
    if (!this.pc) return;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ type: "offer", sdp: offer.sdp ?? "" });
    this.log("signal", "→ offer", { sdpBytes: offer.sdp?.length ?? 0 });
  }

  private async renegotiate() {
    if (!this.pc || this.closed || this.pc.signalingState !== "stable") return;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ type: "offer", sdp: offer.sdp ?? "" });
    this.log("signal", "→ offer (renegotiate)", { sdpBytes: offer.sdp?.length ?? 0 });
  }

  private async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;

    if (!this.pc.remoteDescription) {
      this.pendingIce.push(candidate);
      this.log("ice", `Remote ICE buffered (${iceCandidateType(candidate)})`, {
        buffered: this.pendingIce.length,
      });
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
      this.log("ice", `Remote ICE applied (${iceCandidateType(candidate)})`);
    } catch (err) {
      this.log("ice", "addIceCandidate failed", err, "error");
      throw err;
    }
  }

  private async flushPendingIce() {
    if (!this.pc || this.pendingIce.length === 0) return;

    this.log("ice", `Flushing ${this.pendingIce.length} buffered ICE candidates`);
    const pending = this.pendingIce;
    this.pendingIce = [];

    for (const candidate of pending) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  private sendSignal(payload: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("signal", "Cannot send — WebSocket not open", {
        state: this.ws?.readyState,
        payload: payload.type,
      }, "warn");
      return;
    }

    if (payload.type !== "ice") {
      this.log("signal", `→ ${String(payload.type)}`);
    }

    this.ws.send(JSON.stringify({ ...payload, roomId: this.roomId }));
  }

  private stopTransportMonitoring() {
    window.clearTimeout(this.transportCheckTimer);
    this.transportCheckTimer = 0;
    this.transportCheckAttempts = 0;
  }

  private startTransportMonitoring() {
    this.stopTransportMonitoring();
    this.transportCheckAttempts = 0;
    void this.refreshTransportMode();
  }

  private async refreshTransportMode() {
    if (!this.pc || this.closed || this.pc.connectionState !== "connected") return;

    const mode = await detectIceTransportMode(this.pc);
    if (!mode || this.closed) {
      if (this.transportCheckAttempts < 12) {
        this.transportCheckAttempts += 1;
        this.transportCheckTimer = window.setTimeout(() => {
          void this.refreshTransportMode();
        }, 500);
      }
      return;
    }

    if (mode !== this.transportMode) {
      this.transportMode = mode;
      this.log("ice", `Active transport: ${mode === "turn" ? "TURN relay" : "P2P direct"}`, {
        priority: "host/srflx before relay",
      });
      this.onTransportMode(mode);
    }

    this.stopTransportMonitoring();
  }
}
