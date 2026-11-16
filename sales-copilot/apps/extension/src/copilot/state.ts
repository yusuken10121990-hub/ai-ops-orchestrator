/**
 * copilot ウィンドウの表示状態（純粋関数）。
 * - カードは検証済みの advice.card が丸ごと届いたときだけ差し替える（途中文を描画しない）
 * - 返却順が逆転しても、古いカードで新しい表示を上書きしない（createdAt / contextRevision）
 * - advice.invalidated を尊重（カードより先に届いた無効化も保持）
 * - 表示固定中は固定カードを残し、新しいカードがあれば「参考」＋お知らせ
 */
import {
  AdviceCard,
  ServerMessage,
  type AdviceCardStatus,
  type AdviceInvalidationReason,
  type AdviceWarning,
  type ErrorMessage,
  type PinStateMessage,
  type StatusMessage,
  type TranscriptSegmentMessage,
  type UsageMessage,
  type WarningMessage,
} from '@sales-copilot/contracts';

export const MAX_CARDS = 30;
export const MAX_SEGMENTS = 300;
export const MAX_WARNINGS = 5;

export interface CopilotState {
  sessionId: string | null;
  cards: Record<string, AdviceCard>;
  cardOrder: string[];
  liveId: string | null;
  invalidated: Record<string, AdviceInvalidationReason>;
  pinnedId: string | null;
  serverPin: PinStateMessage | null;
  segments: Record<string, TranscriptSegmentMessage>;
  segmentOrder: string[];
  status: StatusMessage | null;
  warnings: WarningMessage[];
  usage: UsageMessage | null;
  lastError: ErrorMessage | null;
  /** 検証に通らず捨てたメッセージ数（表示しない）。 */
  rejected: number;
}

export const initialCopilotState: CopilotState = {
  sessionId: null,
  cards: {},
  cardOrder: [],
  liveId: null,
  invalidated: {},
  pinnedId: null,
  serverPin: null,
  segments: {},
  segmentOrder: [],
  status: null,
  warnings: [],
  usage: null,
  lastError: null,
  rejected: 0,
};

export type CopilotAction =
  | { type: 'server'; message: unknown }
  | { type: 'pin'; adviceId: string }
  | { type: 'unpin' }
  | { type: 'reset' };

function isNewer(a: AdviceCard, b: AdviceCard): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.contextRevision > b.contextRevision;
}

function trimCards(cards: Record<string, AdviceCard>, order: string[], keep: Set<string>) {
  if (order.length <= MAX_CARDS) return { cards, order };
  const drop = order.slice(0, order.length - MAX_CARDS).filter((id) => !keep.has(id));
  const dropSet = new Set(drop);
  const next = { ...cards };
  for (const id of drop) delete next[id];
  return { cards: next, order: order.filter((id) => !dropSet.has(id)) };
}

function onCard(state: CopilotState, raw: AdviceCard): CopilotState {
  // 二重検証: 完全なカードだけ受け付ける
  const parsed = AdviceCard.safeParse(raw);
  if (!parsed.success) return { ...state, rejected: state.rejected + 1 };
  let card = parsed.data;
  if (state.sessionId && card.sessionId !== state.sessionId) return { ...state, rejected: state.rejected + 1 };
  if (state.invalidated[card.adviceId]) card = { ...card, status: 'invalidated' };
  const exists = !!state.cards[card.adviceId];
  const cards = { ...state.cards, [card.adviceId]: card };
  const order = exists ? state.cardOrder : [...state.cardOrder, card.adviceId];
  let liveId = state.liveId;
  const live = liveId ? cards[liveId] : undefined;
  if (card.status !== 'invalidated') {
    if (!live || live.adviceId === card.adviceId || isNewer(card, live)) liveId = card.adviceId;
  }
  const keep = new Set([liveId, state.pinnedId].filter((x): x is string => !!x));
  const t = trimCards(cards, order, keep);
  return { ...state, cards: t.cards, cardOrder: t.order, liveId };
}

function onInvalidated(state: CopilotState, adviceId: string, reason: AdviceInvalidationReason): CopilotState {
  const invalidated = { ...state.invalidated, [adviceId]: reason };
  const c = state.cards[adviceId];
  const cards = c ? { ...state.cards, [adviceId]: { ...c, status: 'invalidated' as const } } : state.cards;
  return { ...state, invalidated, cards };
}

function onSegment(state: CopilotState, seg: TranscriptSegmentMessage): CopilotState {
  const prev = state.segments[seg.segmentId];
  if (prev && prev.revision > seg.revision) return state;
  const segments = { ...state.segments, [seg.segmentId]: seg };
  let order = prev ? state.segmentOrder : [...state.segmentOrder, seg.segmentId];
  if (order.length > MAX_SEGMENTS) {
    const drop = order.slice(0, order.length - MAX_SEGMENTS);
    for (const id of drop) delete segments[id];
    order = order.slice(order.length - MAX_SEGMENTS);
  }
  return { ...state, segments, segmentOrder: order };
}

export function copilotReducer(state: CopilotState, action: CopilotAction): CopilotState {
  switch (action.type) {
    case 'reset':
      return initialCopilotState;
    case 'pin': {
      const c = state.cards[action.adviceId];
      if (!c || c.status === 'invalidated') return state;
      return { ...state, pinnedId: action.adviceId };
    }
    case 'unpin':
      return { ...state, pinnedId: null, serverPin: null };
    case 'server': {
      const parsed = ServerMessage.safeParse(action.message);
      if (!parsed.success) return { ...state, rejected: state.rejected + 1 };
      const m = parsed.data;
      switch (m.type) {
        case 'status':
          return { ...state, status: m, sessionId: state.sessionId ?? m.sessionId };
        case 'advice.card':
          return onCard(state, m.card);
        case 'advice.invalidated':
          return onInvalidated(state, m.adviceId, m.reason);
        case 'card.pin.state':
          return { ...state, serverPin: m };
        case 'transcript.segment':
          return onSegment(state, m);
        case 'warning':
          return { ...state, warnings: [...state.warnings.filter((w) => w.warningId !== m.warningId), m].slice(-MAX_WARNINGS) };
        case 'usage':
          return { ...state, usage: m };
        case 'error':
          return { ...state, lastError: m };
        case 'hello.ack':
          return state;
      }
      return state;
    }
  }
}

export interface CardView {
  mode: 'pinned' | 'live' | 'empty';
  card: AdviceCard | null;
  displayStatus: AdviceCardStatus | null;
  warnings: AdviceWarning[];
  hasNewerCard: boolean;
  invalidReason: AdviceInvalidationReason | null;
}

const STATUS_RANK: Record<AdviceCardStatus, number> = { current: 0, reference: 1, invalidated: 2 };

function worse(a: AdviceCardStatus, b: AdviceCardStatus | null | undefined): AdviceCardStatus {
  if (!b) return a;
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function addWarning(ws: AdviceWarning[], w: AdviceWarning): void {
  if (!ws.some((x) => x.code === w.code)) ws.push(w);
}

/** 表示するカードと、その表示上の状態を決める。 */
export function selectCardView(state: CopilotState, now: number): CardView {
  const live = state.liveId ? state.cards[state.liveId] ?? null : null;
  const pinned = state.pinnedId ? state.cards[state.pinnedId] ?? null : null;
  const target = pinned ?? live;
  if (!target) return { mode: 'empty', card: null, displayStatus: null, warnings: [], hasNewerCard: false, invalidReason: null };
  const warnings = [...target.warnings];
  let status: AdviceCardStatus = target.status;
  const invalidReason = state.invalidated[target.adviceId] ?? null;
  if (invalidReason) status = 'invalidated';
  if (status === 'current' && now >= target.expiresAt) {
    status = 'reference';
    addWarning(warnings, { code: 'stale', message: '時間が経過したため参考扱いです' });
  }
  const hasNewerCard = !!pinned && !!live && live.adviceId !== pinned.adviceId && isNewer(live, pinned);
  if (pinned) {
    const sp = state.serverPin;
    if (sp && sp.pinnedAdviceId === pinned.adviceId) {
      status = worse(status, sp.displayStatus);
      for (const w of sp.warnings) addWarning(warnings, w);
    }
    if (hasNewerCard && status === 'current') status = 'reference';
    if (status !== 'current') {
      addWarning(warnings, {
        code: 'pinned_stale',
        message: status === 'invalidated' ? '固定中のカードは前提が崩れています' : '固定中のカードは現行推奨ではありません',
      });
    }
  }
  return { mode: pinned ? 'pinned' : 'live', card: target, displayStatus: status, warnings, hasNewerCard, invalidReason };
}

/** 文字起こし履歴（開始時刻順）。 */
export function selectTranscript(state: CopilotState): TranscriptSegmentMessage[] {
  return state.segmentOrder
    .map((id) => state.segments[id])
    .filter((s): s is TranscriptSegmentMessage => !!s)
    .sort((a, b) => a.startMs - b.startMs);
}
