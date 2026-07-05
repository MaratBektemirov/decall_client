export type IceTransportMode = "p2p" | "turn";

type CandidatePairStats = RTCStats & {
  state?: string;
  nominated?: boolean;
  localCandidateId?: string;
};

type LocalCandidateStats = RTCStats & {
  candidateType?: string;
};

export async function detectIceTransportMode(
  pc: RTCPeerConnection,
): Promise<IceTransportMode | null> {
  const stats = await pc.getStats();
  let localCandidateId: string | undefined;

  for (const report of stats.values()) {
    if (report.type !== "candidate-pair") continue;

    const pair = report as CandidatePairStats;
    if (pair.state === "succeeded" && pair.nominated) {
      localCandidateId = pair.localCandidateId;
      break;
    }
  }

  if (!localCandidateId) {
    for (const report of stats.values()) {
      if (report.type !== "candidate-pair") continue;

      const pair = report as CandidatePairStats;
      if (pair.state === "succeeded") {
        localCandidateId = pair.localCandidateId;
        break;
      }
    }
  }

  if (!localCandidateId) return null;

  const localCandidate = stats.get(localCandidateId) as LocalCandidateStats | undefined;
  if (!localCandidate || localCandidate.type !== "local-candidate") return null;

  const type = localCandidate.candidateType ?? "";
  if (type === "relay") return "turn";
  if (type === "host" || type === "srflx" || type === "prflx") return "p2p";

  return null;
}
