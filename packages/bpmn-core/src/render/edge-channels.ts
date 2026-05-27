import BpmnModdle from "bpmn-moddle";

/**
 * Post-routing pass that stacks horizontally co-located edges onto distinct
 * channels *only when they originate from different source gateways*. Edges
 * leaving the same source share a single trunk (the desired "merged outgoing"
 * look — see canon-2 parallel-lane convergence). Edges from unrelated sources
 * that happen to share a Y band get nudged apart so the user can visually
 * separate them.
 *
 * Operates on the longest interior horizontal segment of each sequence-flow
 * BPMNEdge — i.e., a segment flanked on both sides by vertical risers. Edges
 * that are purely horizontal (2-point straight-h) or have no interior
 * horizontal segment are left untouched.
 */

const Y_BAND = 10;
const CHANNEL_PITCH = 12;
const MIN_SEG_LEN_FOR_STACK = 24;
const LANE_BOUNDARY_EPS = 6;

interface SegInfo {
  waypoints: any[];
  horizIdx: number;
  y: number;
  minX: number;
  maxX: number;
  sourceId: string;
  participantKey: string;
}

export async function distributeParallelChannels(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as any;

  const dg = defs.diagrams?.[0];
  if (!dg?.plane) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }
  const planeElements: any[] = Array.isArray(dg.plane.planeElement) ? dg.plane.planeElement : [];

  const participantByNodeId = buildParticipantMap(defs);

  // Collect lane boundary Ys so we can avoid placing channels on top of them.
  const laneBoundaryYs: number[] = [];
  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNShape" || el.bpmnElement?.$type !== "bpmn:Lane") continue;
    if (!el.bounds) continue;
    laneBoundaryYs.push(el.bounds.y);
    laneBoundaryYs.push(el.bounds.y + el.bounds.height);
  }

  const segments: SegInfo[] = [];
  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNEdge") continue;
    const ref = el.bpmnElement;
    if (!ref || ref.$type !== "bpmn:SequenceFlow") continue;
    const srcId = ref.sourceRef?.id;
    if (!srcId) continue;
    const wp = el.waypoint ?? [];
    if (wp.length < 4) continue;

    let bestIdx = -1;
    let bestLen = 0;
    for (let i = 1; i < wp.length - 2; i++) {
      const a = wp[i];
      const b = wp[i + 1];
      if (Math.abs(a.y - b.y) > 1) continue;
      const prev = wp[i - 1];
      const next = wp[i + 2];
      if (Math.abs(prev.x - a.x) > 1) continue;
      if (Math.abs(next.x - b.x) > 1) continue;
      const len = Math.abs(b.x - a.x);
      if (len > bestLen) {
        bestLen = len;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestLen < MIN_SEG_LEN_FOR_STACK) continue;

    const a = wp[bestIdx];
    const b = wp[bestIdx + 1];
    segments.push({
      waypoints: wp,
      horizIdx: bestIdx,
      y: a.y,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      sourceId: srcId,
      participantKey: participantByNodeId.get(srcId) ?? "_",
    });
  }

  const bands = new Map<string, SegInfo[]>();
  for (const s of segments) {
    const yBand = Math.round(s.y / Y_BAND) * Y_BAND;
    const key = `${s.participantKey}:${yBand}`;
    const arr = bands.get(key);
    if (arr) arr.push(s);
    else bands.set(key, [s]);
  }

  // Pass A: nudge every horizontal segment that sits exactly on a lane boundary.
  // This catches loop-back edges and other singletons that the channel-stacking
  // logic below would skip (since they don't share their band with another source).
  if (laneBoundaryYs.length > 0) {
    for (const el of planeElements) {
      if (el.$type !== "bpmndi:BPMNEdge") continue;
      const wp = el.waypoint ?? [];
      for (let i = 0; i < wp.length - 1; i++) {
        const a = wp[i];
        const b = wp[i + 1];
        if (Math.abs(a.y - b.y) > 1) continue;
        if (Math.abs(a.x - b.x) < 15) continue;
        // Only nudge interior horizontal segments — those flanked by vertical
        // risers — so we don't shift entry/exit ports off their shapes.
        if (i === 0 || i === wp.length - 2) continue;
        const prev = wp[i - 1];
        const next = wp[i + 2];
        if (Math.abs(prev.x - a.x) > 1 || Math.abs(next.x - b.x) > 1) continue;
        const newY = nudgeAwayFromLaneBoundary(a.y, laneBoundaryYs);
        if (newY !== a.y) {
          a.y = newY;
          b.y = newY;
        }
      }
    }
  }

  for (const group of bands.values()) {
    if (group.length < 2) continue;

    const sourceGroups = new Map<string, SegInfo[]>();
    for (const s of group) {
      const arr = sourceGroups.get(s.sourceId);
      if (arr) arr.push(s);
      else sourceGroups.set(s.sourceId, [s]);
    }
    if (sourceGroups.size < 2) continue;

    const sourceList = Array.from(sourceGroups.values());
    if (!groupsOverlapInX(sourceList)) continue;

    const baseY = group[0].y;
    const half = (sourceList.length - 1) / 2;
    for (let i = 0; i < sourceList.length; i++) {
      let newY = Math.round(baseY + (i - half) * CHANNEL_PITCH);
      newY = nudgeAwayFromLaneBoundary(newY, laneBoundaryYs);
      for (const seg of sourceList[i]) {
        if (newY === seg.y) continue;
        seg.waypoints[seg.horizIdx].y = newY;
        seg.waypoints[seg.horizIdx + 1].y = newY;
        seg.y = newY;
      }
    }
  }

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

function buildParticipantMap(defs: any): Map<string, string> {
  const map = new Map<string, string>();
  const processToParticipant = new Map<string, string>();
  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Collaboration") continue;
    for (const part of root.participants ?? []) {
      const pid = part.processRef?.id;
      if (pid) processToParticipant.set(pid, part.id);
    }
  }
  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Process") continue;
    const pid = processToParticipant.get(root.id);
    if (!pid) continue;
    for (const fe of root.flowElements ?? []) {
      if (fe.id) map.set(fe.id, pid);
    }
  }
  return map;
}

/**
 * If `y` is within LANE_BOUNDARY_EPS of any lane boundary line, push it inward
 * by `LANE_BOUNDARY_EPS + 1` so the horizontal segment doesn't visually merge
 * with the lane separator.
 */
function nudgeAwayFromLaneBoundary(y: number, boundaries: number[]): number {
  for (const b of boundaries) {
    const d = y - b;
    if (Math.abs(d) <= LANE_BOUNDARY_EPS) {
      return d >= 0 ? b + LANE_BOUNDARY_EPS + 1 : b - LANE_BOUNDARY_EPS - 1;
    }
  }
  return y;
}

function groupsOverlapInX(sources: SegInfo[][]): boolean {
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      for (const a of sources[i]) {
        for (const b of sources[j]) {
          if (a.minX < b.maxX && b.minX < a.maxX) return true;
        }
      }
    }
  }
  return false;
}
