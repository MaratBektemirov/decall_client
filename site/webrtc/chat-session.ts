import { signalWebSocketUrl } from "site/services/signal-url";

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

export class ChatSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket | null = null;
  private roomId = "";
  private role: "host" | "guest" = "guest";
  private pendingIce: RTCIceCandidateInit[] = [];

  constructor(
    private onMessage: (msg: ChatMessage) => void,
    private onStatus: (status: string) => void,
  ) {}

  async openRoom(roomId: string) {
    await this.connect(roomId, "host");
  }

  async joinRoom(roomId: string) {
    await this.connect(roomId, "guest");
  }

  send(text: string) {
    const value = text.trim();
    if (!value || !this.dc || this.dc.readyState !== "open") return;

    this.dc.send(value);
    this.onMessage({ from: "me", text: value });
  }

  close() {
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    this.dc = null;
    this.pc = null;
    this.ws = null;
    this.roomId = "";
    this.pendingIce = [];
  }

  private async connect(roomId: string, role: "host" | "guest") {
    this.close();

    this.roomId = roomId;
    this.role = role;
    this.onStatus("connecting…");

    const ws = new WebSocket(signalWebSocketUrl());
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("signal connection failed")), { once: true });
    });

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.sendSignal({
        type: "ice",
        candidate: event.candidate.toJSON(),
      });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState ?? "closed";

      if (state === "connected") {
        this.onStatus("connected");
        return;
      }

      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.onStatus("disconnected");
      }
    };

    if (role === "host") {
      const channel = this.pc.createDataChannel("chat");
      this.wireDataChannel(channel);
    } else {
      this.pc.ondatachannel = (event) => {
        this.wireDataChannel(event.channel);
      };
    }

    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as SignalMessage;
      void this.handleSignal(payload).catch((err: unknown) => {
        const text = err instanceof Error ? err.message : "signaling error";
        this.onStatus("error");
        this.onMessage({ from: "system", text });
      });
    });

    ws.addEventListener("close", () => {
      this.onStatus("disconnected");
      this.onMessage({ from: "system", text: "Signaling closed" });
    });

    this.sendSignal({ type: "join", roomId, role });
  }

  private wireDataChannel(channel: RTCDataChannel) {
    this.dc = channel;

    channel.onopen = () => {
      this.onStatus("chat ready");
      this.onMessage({ from: "system", text: "Peer-to-peer chat is open" });
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
        this.onMessage({ from: "system", text: message.message ?? "error" });
        break;
    }
  }

  private async createOffer() {
    if (!this.pc) return;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ type: "offer", sdp: offer.sdp ?? "" });
  }

  private async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;

    if (!this.pc.remoteDescription) {
      this.pendingIce.push(candidate);
      return;
    }

    await this.pc.addIceCandidate(candidate);
  }

  private async flushPendingIce() {
    if (!this.pc) return;

    const pending = this.pendingIce;
    this.pendingIce = [];

    for (const candidate of pending) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  private sendSignal(payload: Record<string, unknown>) {
    this.ws?.send(JSON.stringify({ ...payload, roomId: this.roomId }));
  }
}
