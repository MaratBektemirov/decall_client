import { signalWebSocketUrl } from "site/services/signal-url";
import {
  decallLog,
  describeWebSocketClose,
  hintForIceFailure,
  hintForSignalFailure,
  iceCandidateType,
} from "site/utils/decall-log";

export type ChatMessage = {
  from: "me" | "peer" | "system";
  text: string;
};

type SignalMessage = {
  type: string;
  role?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  message?: string;
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

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
  private closed = false;

  constructor(
    private onMessage: (msg: ChatMessage) => void,
    private onStatus: (status: string) => void,
    private localStream: MediaStream | null,
    private onRemoteStream: (stream: MediaStream) => void,
  ) {
    sessionCounter += 1;
    this.sessionId = `s${sessionCounter}`;
    this.log("session", `ChatSession created (STUN: ${ICE_SERVERS[0]?.urls})`);
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

  close() {
    const hadResources = Boolean(this.ws || this.pc || this.dc);
    if (this.closed && !hadResources) return;

    this.closed = true;
    if (hadResources) this.log("session", "Closing session");
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    this.dc = null;
    this.pc = null;
    this.ws = null;
    this.roomId = "";
    this.pendingIce = [];
    this.iceCandidateTypes.clear();
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

    this.roomId = roomId;
    this.role = role;
    this.onStatus("connecting…");

    const signalUrl = signalWebSocketUrl();
    this.log("signal", "Connecting WebSocket", { url: signalUrl, role, roomId });

    const ws = new WebSocket(signalUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.log("signal", "WebSocket open");
    });

    ws.addEventListener("error", () => {
      this.log("signal", "WebSocket error", hintForSignalFailure(), "error");
    });

    ws.addEventListener("close", (event) => {
      const hint = describeWebSocketClose(event.code, event.reason);
      this.log("signal", "WebSocket closed", { code: event.code, reason: event.reason, hint }, "warn");
      this.onStatus("disconnected");
      this.onMessage({ from: "system", text: `Signaling closed: ${hint}` });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => {
          reject(new Error("signal connection failed"));
        }, { once: true });
      });
    } catch (err) {
      this.log("signal", "WebSocket connect failed", err, "error");
      throw err;
    }

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.log("webrtc", "RTCPeerConnection created", { iceServers: ICE_SERVERS });

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
      const stream = event.streams?.[0];
      this.log("webrtc", "Remote track received", {
        kind: event.track.kind,
        streamId: stream?.id,
        trackCount: stream?.getTracks().length,
      });
      if (stream) this.onRemoteStream(stream);
    };

    this.pc.onicecandidate = (event) => {
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
      this.log("ice", `ICE gathering: ${this.pc?.iceGatheringState ?? "unknown"}`);
    };

    this.pc.oniceconnectionstatechange = () => {
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
      this.log("webrtc", `Signaling state: ${this.pc?.signalingState ?? "unknown"}`);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState ?? "closed";
      this.log("webrtc", `Connection state: ${state}`);

      if (state === "connected") {
        this.onStatus("connected");
        return;
      }

      if (state === "failed") {
        this.log("webrtc", "Peer connection failed", hintForIceFailure(), "error");
        this.onStatus("error");
        this.onMessage({ from: "system", text: hintForIceFailure() });
        return;
      }

      if (state === "disconnected" || state === "closed") {
        this.onStatus("disconnected");
      }
    };

    if (role === "host") {
      const channel = this.pc.createDataChannel("chat");
      this.log("webrtc", "Data channel created (host)");
      this.wireDataChannel(channel);
    } else {
      this.pc.ondatachannel = (event) => {
        this.log("webrtc", "Data channel received (guest)");
        this.wireDataChannel(event.channel);
      };
    }

    ws.addEventListener("message", (event) => {
      let payload: SignalMessage;
      try {
        payload = JSON.parse(String(event.data)) as SignalMessage;
      } catch (err) {
        this.log("signal", "Invalid signal JSON", err, "error");
        return;
      }

      this.log("signal", `← ${payload.type}`, this.sanitizeSignalForLog(payload));
      void this.handleSignal(payload).catch((err: unknown) => {
        const text = err instanceof Error ? err.message : "signaling error";
        this.log("signal", "Signal handler error", err, "error");
        this.onStatus("error");
        this.onMessage({ from: "system", text });
      });
    });

    this.sendSignal({ type: "join", roomId, role });
    this.log("signal", "→ join", { roomId, role });
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

  private wireDataChannel(channel: RTCDataChannel) {
    this.dc = channel;

    channel.onopen = () => {
      this.log("webrtc", "Data channel open");
      this.onStatus("chat ready");
      this.onMessage({ from: "system", text: "Peer-to-peer chat is open" });
    };

    channel.onclose = () => {
      this.log("webrtc", "Data channel closed", null, "warn");
    };

    channel.onerror = () => {
      this.log("webrtc", "Data channel error", null, "error");
    };

    channel.onmessage = (event) => {
      this.onMessage({ from: "peer", text: String(event.data) });
    };
  }

  private async handleSignal(message: SignalMessage) {
    if (!this.pc) return;

    switch (message.type) {
      case "joined":
        this.onStatus(message.role === "host" ? "waiting for peer…" : "waiting for host…");
        break;
      case "waiting":
        this.onStatus("waiting for peer…");
        break;
      case "peer-joined":
        this.onStatus("negotiating…");
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
      case "peer-left":
        this.onStatus("peer left");
        this.onMessage({ from: "system", text: "Peer left" });
        break;
      case "error":
        this.onStatus("error");
        this.log("signal", "Server error", message.message, "error");
        this.onMessage({ from: "system", text: message.message ?? "error" });
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
}
