import { createToken, Lexer, type IToken, type TokenType } from "chevrotain";
import type { DslError, EventSubtype, TaskType } from "./ast.js";

export type ParallelLane = { pool?: string; label: string; taskType?: TaskType };

export type LinePayload =
  | { kind: "Blank" }
  | { kind: "Annotation"; text: string }
  | { kind: "PoolDefault"; pool: string }
  | { kind: "Task"; pool?: string; label: string; taskType?: TaskType; inlineAnnotation?: string }
  | {
      kind: "Event";
      pool?: string;
      eventType: EventSubtype;
      label: string;
      rawInner: string;
      isDoubleParen: boolean;
    }
  | { kind: "Data"; pool?: string; storeKind: "object" | "store"; label: string }
  | { kind: "GatewayQuestion"; pool?: string; label: string }
  | { kind: "Parallel"; pool?: string; lanes: ParallelLane[] }
  | { kind: "FragmentMarker" };

export const T = {
  Blank: createToken({ name: "Blank", pattern: Lexer.NA }),
  Annotation: createToken({ name: "Annotation", pattern: Lexer.NA }),
  PoolDefault: createToken({ name: "PoolDefault", pattern: Lexer.NA }),
  Task: createToken({ name: "Task", pattern: Lexer.NA }),
  Event: createToken({ name: "Event", pattern: Lexer.NA }),
  Data: createToken({ name: "Data", pattern: Lexer.NA }),
  GatewayQuestion: createToken({ name: "GatewayQuestion", pattern: Lexer.NA }),
  Parallel: createToken({ name: "Parallel", pattern: Lexer.NA }),
  FragmentMarker: createToken({ name: "FragmentMarker", pattern: Lexer.NA }),
};

export const ALL_TOKENS: TokenType[] = [
  T.Blank,
  T.Annotation,
  T.PoolDefault,
  T.Task,
  T.Event,
  T.Data,
  T.GatewayQuestion,
  T.Parallel,
  T.FragmentMarker,
];

export type LineToken = IToken & { payload: LinePayload };

export type LexResult = {
  tokens: LineToken[];
  errors: DslError[];
};

const POOL_PREFIX_RE = /^(\p{Lu}[\p{L}\p{N}_ \-/]*?):(?:\s+(.*))?$/u;
const FRAGMENT_RE = /^\s*\.\.\.\s*$/;
const EVENT_RE = /^\s*\((.+)\)\s*$/;
const END_EVENT_RE = /^\s*\(\((.+)\)\)\s*$/;
const DATA_STORE_RE = /^\s*\[\s*db\s+(.+?)\s*\]\s*$/;
const DATA_OBJECT_RE = /^\s*\[\s*(.+?)\s*\]\s*$/;

const TASK_TYPE_KEYWORDS: ReadonlySet<TaskType> = new Set<TaskType>([
  "user",
  "service",
  "rule",
  "manual",
  "receive",
  "send",
  "script",
]);

/**
 * If `text` begins with one of the task-type keywords (followed by whitespace and
 * a non-empty remainder), strip the keyword and return it. Otherwise return the
 * input unchanged with `taskType` undefined.
 *
 * Spec §6.3 — "Prefix the task label with one of these keywords to set its BPMN
 * task type. The keyword is removed from the visible label."
 */
function stripTaskType(text: string): { taskType?: TaskType; label: string } {
  const m = /^([a-z]+)\s+(\S.*)$/.exec(text);
  if (!m) return { label: text };
  const head = m[1] as TaskType;
  if (!TASK_TYPE_KEYWORDS.has(head)) return { label: text };
  return { taskType: head, label: m[2].trim() };
}

const EVENT_KEYWORDS: ReadonlySet<EventSubtype> = new Set<EventSubtype>([
  "start",
  "finish",
  "end",
  "timer",
  "deadline",
  "exception",
  "received",
  "receive",
  "send",
  "escalated",
  "escalate",
  "message",
  "signal",
  "error",
  "terminate",
  "link",
  "publish",
  "notify",
]);

function classifyEventInner(inner: string): { eventType: EventSubtype; label: string } {
  const trimmed = inner.trim();
  const firstSpace = trimmed.indexOf(" ");
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  if (EVENT_KEYWORDS.has(head as EventSubtype)) {
    const label = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
    return { eventType: head as EventSubtype, label };
  }
  return { eventType: "unknown", label: trimmed };
}

function stripInlineAnnotation(text: string): { body: string; annotation?: string } {
  const idx = text.indexOf("//");
  if (idx <= 0) return { body: text };
  const before = text.slice(0, idx);
  if (!/\s$/.test(before)) return { body: text };
  return { body: before.replace(/\s+$/, ""), annotation: text.slice(idx + 2).trim() };
}

function splitParallelLanes(content: string): ParallelLane[] {
  const segments = content.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
  return segments.map((seg) => {
    const m = seg.match(POOL_PREFIX_RE);
    if (m && m[2]) {
      const { taskType, label } = stripTaskType(m[2].trim());
      return { pool: m[1].trim(), label, taskType };
    }
    const { taskType, label } = stripTaskType(seg);
    return { label, taskType };
  });
}

function classifyContent(
  content: string,
  pool: string | undefined,
  errors: DslError[],
  lineNo: number,
): LinePayload {
  if (FRAGMENT_RE.test(content)) return { kind: "FragmentMarker" };

  const endEventMatch = END_EVENT_RE.exec(content);
  if (endEventMatch) {
    const { eventType, label } = classifyEventInner(endEventMatch[1]);
    return {
      kind: "Event",
      pool,
      eventType,
      label,
      rawInner: endEventMatch[1].trim(),
      isDoubleParen: true,
    };
  }

  const eventMatch = EVENT_RE.exec(content);
  if (eventMatch) {
    const { eventType, label } = classifyEventInner(eventMatch[1]);
    return {
      kind: "Event",
      pool,
      eventType,
      label,
      rawInner: eventMatch[1].trim(),
      isDoubleParen: false,
    };
  }

  const storeMatch = DATA_STORE_RE.exec(content);
  if (storeMatch) return { kind: "Data", pool, storeKind: "store", label: storeMatch[1].trim() };

  const objectMatch = DATA_OBJECT_RE.exec(content);
  if (objectMatch) return { kind: "Data", pool, storeKind: "object", label: objectMatch[1].trim() };

  if (content.includes("|")) {
    const lanes = splitParallelLanes(content);
    return { kind: "Parallel", pool, lanes };
  }

  const trimmed = content.trim();
  if (trimmed.endsWith("?")) {
    return { kind: "GatewayQuestion", pool, label: trimmed };
  }

  const { body, annotation } = stripInlineAnnotation(trimmed);
  if (annotation !== undefined) {
    errors.push({
      line: lineNo,
      code: "INLINE-COMMENT",
      severity: "warning",
      message: `Inline '//' annotation is non-canonical (spec requires line-start). Attached as annotation to '${body}'.`,
    });
    const { taskType, label } = stripTaskType(body);
    return { kind: "Task", pool, label, taskType, inlineAnnotation: annotation };
  }

  const { taskType, label } = stripTaskType(trimmed);
  return { kind: "Task", pool, label, taskType };
}

function classifyLine(rawLine: string, lineNo: number, errors: DslError[]): LinePayload {
  if (rawLine.trim().length === 0) return { kind: "Blank" };
  if (rawLine.startsWith("///")) return { kind: "Blank" };
  if (rawLine.startsWith("//")) {
    return { kind: "Annotation", text: rawLine.slice(2).trim() };
  }

  // Form: "<taskType> Pool: body" — task-type keyword precedes a pool prefix.
  // Seen in canonical example 2 (`user Gate Agent: Scan Passes`).
  const typedPoolMatch = /^([a-z]+)\s+(\p{Lu}[\p{L}\p{N}_ \-/]*?):\s+(.+)$/u.exec(rawLine);
  if (typedPoolMatch && TASK_TYPE_KEYWORDS.has(typedPoolMatch[1] as TaskType)) {
    return {
      kind: "Task",
      pool: typedPoolMatch[2].trim(),
      label: typedPoolMatch[3].trim(),
      taskType: typedPoolMatch[1] as TaskType,
    };
  }

  const poolMatch = POOL_PREFIX_RE.exec(rawLine);
  if (poolMatch) {
    const pool = poolMatch[1].trim();
    const body = poolMatch[2];
    if (body === undefined || body.trim().length === 0) {
      return { kind: "PoolDefault", pool };
    }
    return classifyContent(body, pool, errors, lineNo);
  }

  return classifyContent(rawLine, undefined, errors, lineNo);
}

function tokenTypeFor(payload: LinePayload): TokenType {
  switch (payload.kind) {
    case "Blank":
      return T.Blank;
    case "Annotation":
      return T.Annotation;
    case "PoolDefault":
      return T.PoolDefault;
    case "Task":
      return T.Task;
    case "Event":
      return T.Event;
    case "Data":
      return T.Data;
    case "GatewayQuestion":
      return T.GatewayQuestion;
    case "Parallel":
      return T.Parallel;
    case "FragmentMarker":
      return T.FragmentMarker;
  }
}

export function preprocess(source: string): { lines: string[]; lineMap: number[] } {
  let text = source;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const allLines = text.split(/\r\n|\n|\r/);

  let start = 0;
  let end = allLines.length;
  const isFence = (s: string) => s.trim().startsWith("```");

  // Find first non-blank line; if it is a fence, strip it and the next matching fence.
  let firstNonBlank = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].trim().length > 0) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank !== -1 && isFence(allLines[firstNonBlank])) {
    start = firstNonBlank + 1;
    for (let i = allLines.length - 1; i >= start; i--) {
      if (allLines[i].trim().length > 0) {
        if (isFence(allLines[i])) end = i;
        break;
      }
    }
  }

  const lines: string[] = [];
  const lineMap: number[] = [];
  for (let i = start; i < end; i++) {
    lines.push(allLines[i]);
    lineMap.push(i + 1);
  }
  return { lines, lineMap };
}

export function tokenize(source: string): LexResult {
  const errors: DslError[] = [];
  const { lines, lineMap } = preprocess(source);
  const tokens: LineToken[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const sourceLine = lineMap[i];
    const payload = classifyLine(raw, sourceLine, errors);
    const tokType = tokenTypeFor(payload);
    const startOffset = offset;
    const endOffset = offset + raw.length;
    const tok: LineToken = {
      image: raw,
      startOffset,
      endOffset,
      startLine: sourceLine,
      endLine: sourceLine,
      startColumn: 1,
      endColumn: Math.max(1, raw.length),
      tokenTypeIdx: (tokType as unknown as { tokenTypeIdx: number }).tokenTypeIdx,
      tokenType: tokType,
      payload,
    };
    tokens.push(tok);
    offset = endOffset + 1;
  }
  return { tokens, errors };
}
