import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CoachingRule,
  LEARNING_LIMITS,
  RuleHistoryEntry,
  RuleProposal,
  type FeedbackRating,
  type LearningSettings,
  type RatedCardSample,
  type RuleHistoryAction,
  type RuleProposalDraft,
  type RuleScope,
  type RulesVersionStat,
} from '@sales-copilot/contracts';

/**
 * 学習（承認制）の永続化。Store と同じ SQLite を使う（data/ は Git 管理外）。
 * - 評価の記録: 会話本文・顧客名は持たない。カードの文面と商談目的は設定 saveCardText=ON のときだけ。
 * - ルール全体の版（rulesVersion）: 有効なルールの組み合わせが変わるたびに +1。0 = ルールなし。
 */
export const LEARNING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS learning_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rule_proposals (
    proposal_id TEXT PRIMARY KEY,
    rule TEXT NOT NULL,
    reason TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS coaching_rules (
    rule_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    version INTEGER NOT NULL,
    source_proposal_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rule_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT,
    proposal_id TEXT,
    action TEXT NOT NULL,
    text TEXT NOT NULL,
    scope TEXT NOT NULL,
    rules_version INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rule_sets (
    version INTEGER PRIMARY KEY,
    rule_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

/** feedback テーブルへ後から足す列（既存DBは ALTER TABLE で追加）。 */
const FEEDBACK_EXTRA_COLUMNS: ReadonlyArray<[string, string]> = [
  ['session_id', 'TEXT'],
  ['rules_version', 'INTEGER'],
  ['headline', 'TEXT'],
  ['say', 'TEXT'],
  ['avoid', 'TEXT'],
  ['situation', 'TEXT'],
  ['purpose', 'TEXT'],
];

export function migrateFeedbackColumns(db: DatabaseSync): void {
  const cols = new Set((db.prepare('PRAGMA table_info(feedback)').all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of FEEDBACK_EXTRA_COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${type}`);
  }
}

export interface ActiveRuleSet {
  version: number;
  rules: CoachingRule[];
}

export type LearningError = 'not_found' | 'already_decided' | 'too_many_rules';

interface RuleRow {
  rule_id: string;
  text: string;
  scope: string;
  status: string;
  approved_at: number;
  version: number;
  source_proposal_id: string | null;
}

interface ProposalRow {
  proposal_id: string;
  rule: string;
  reason: string;
  scope: string;
  status: string;
  created_at: number;
  decided_at: number | null;
}

/** 版ごとの「役立った」率（n < minSampleForRate はデータ不足）。null 版（学習機能より前）は最後。 */
export function rateByRulesVersion(rows: ReadonlyArray<{ rating: FeedbackRating; rulesVersion: number | null }>): RulesVersionStat[] {
  const groups = new Map<number | null, { n: number; helpful: number }>();
  for (const r of rows) {
    const g = groups.get(r.rulesVersion) ?? { n: 0, helpful: 0 };
    g.n++;
    if (r.rating === 'helpful') g.helpful++;
    groups.set(r.rulesVersion, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([rulesVersion, g]) => ({
      rulesVersion,
      n: g.n,
      helpful: g.helpful,
      rate: g.n > 0 ? g.helpful / g.n : null,
      insufficient: g.n < LEARNING_LIMITS.minSampleForRate,
    }));
}

export class LearningStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  // --- 設定 -------------------------------------------------------------------

  settings(): LearningSettings {
    const v = this.getSetting('save_card_text');
    return { saveCardText: v === null ? true : v === '1' };
  }

  updateSettings(patch: Partial<LearningSettings>): LearningSettings {
    if (patch.saveCardText !== undefined) this.setSetting('save_card_text', patch.saveCardText ? '1' : '0');
    return this.settings();
  }

  lastProposalAt(): number {
    return Number(this.getSetting('last_proposal_at') ?? '0');
  }

  markProposalRun(): void {
    this.setSetting('last_proposal_at', String(this.now()));
  }

  private getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM learning_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO learning_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- 評価サンプル -------------------------------------------------------------

  /** 文面つきで保存された評価（新しい順・上限あり）。 */
  ratedSamples(limit: number = LEARNING_LIMITS.maxSamplesForProposal): RatedCardSample[] {
    const rows = this.db
      .prepare(
        'SELECT rating, kind, headline, say, avoid, situation, purpose, rules_version FROM feedback WHERE headline IS NOT NULL ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as Array<{
      rating: string;
      kind: string | null;
      headline: string | null;
      say: string | null;
      avoid: string | null;
      situation: string | null;
      purpose: string | null;
      rules_version: number | null;
    }>;
    return rows.map((r) => ({
      rating: r.rating as FeedbackRating,
      kind: r.kind,
      headline: r.headline,
      say: r.say,
      avoid: r.avoid,
      situation: parseTags(r.situation),
      purpose: r.purpose,
      rulesVersion: r.rules_version,
    }));
  }

  samplesWithTextCount(since = 0): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE headline IS NOT NULL AND created_at > ?').get(since) as { n: number };
    return Number(r.n);
  }

  stats(): RulesVersionStat[] {
    const rows = this.db.prepare('SELECT rating, rules_version FROM feedback').all() as Array<{ rating: string; rules_version: number | null }>;
    return rateByRulesVersion(rows.map((r) => ({ rating: r.rating as FeedbackRating, rulesVersion: r.rules_version })));
  }

  /** 学習データ（評価・改善案・前回実行時刻）を全部消す。承認済みルールとその履歴は残す（個別に削除できる）。 */
  wipeLearningData(): void {
    this.db.exec('DELETE FROM feedback; DELETE FROM rule_proposals;');
    this.db.prepare("DELETE FROM learning_settings WHERE key = 'last_proposal_at'").run();
  }

  // --- 改善案 -------------------------------------------------------------------

  addProposals(drafts: readonly RuleProposalDraft[]): RuleProposal[] {
    const now = this.now();
    const stmt = this.db.prepare(
      "INSERT INTO rule_proposals (proposal_id, rule, reason, scope, status, created_at, decided_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)",
    );
    const ids: string[] = [];
    for (const d of drafts) {
      const id = `prop_${randomUUID()}`;
      stmt.run(id, d.rule, d.reason, d.scope, now);
      ids.push(id);
    }
    return ids.map((id) => this.getProposal(id)!);
  }

  getProposal(id: string): RuleProposal | null {
    const r = this.db.prepare('SELECT * FROM rule_proposals WHERE proposal_id = ?').get(id) as ProposalRow | undefined;
    return r ? toProposal(r) : null;
  }

  pendingProposals(): RuleProposal[] {
    const rows = this.db.prepare("SELECT * FROM rule_proposals WHERE status = 'pending' ORDER BY created_at, rowid").all() as unknown as ProposalRow[];
    return rows.map(toProposal);
  }

  /** 承認（text/scope を渡すと編集して承認）。呼び出し側で checkRuleText 済みであること。 */
  approveProposal(
    id: string,
    edit: { text?: string; scope?: RuleScope } = {},
  ): { ok: true; rule: CoachingRule; rulesVersion: number } | { ok: false; error: LearningError } {
    const p = this.getProposal(id);
    if (!p) return { ok: false, error: 'not_found' };
    if (p.status !== 'pending') return { ok: false, error: 'already_decided' };
    if (this.listRules().filter((r) => r.status === 'active').length >= LEARNING_LIMITS.maxActiveRules) {
      return { ok: false, error: 'too_many_rules' };
    }
    const text = edit.text ?? p.rule;
    const scope = edit.scope ?? p.scope;
    const edited = text !== p.rule || scope !== p.scope;
    const now = this.now();
    const ruleId = `rule_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE rule_proposals SET status = 'approved', decided_at = ? WHERE proposal_id = ?").run(now, id);
      const version = this.currentRulesVersion() + 1;
      this.db
        .prepare(
          "INSERT INTO coaching_rules (rule_id, text, scope, status, approved_at, version, source_proposal_id, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
        )
        .run(ruleId, text, scope, now, version, id, now);
      this.snapshotRuleSet(version);
      this.logHistory(ruleId, id, edited ? 'edited_and_approved' : 'approved', text, scope, version);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true, rule: this.getRule(ruleId)!, rulesVersion: this.currentRulesVersion() };
  }

  rejectProposal(id: string): { ok: true } | { ok: false; error: LearningError } {
    const p = this.getProposal(id);
    if (!p) return { ok: false, error: 'not_found' };
    if (p.status !== 'pending') return { ok: false, error: 'already_decided' };
    this.db.prepare("UPDATE rule_proposals SET status = 'rejected', decided_at = ? WHERE proposal_id = ?").run(this.now(), id);
    this.logHistory(null, id, 'rejected', p.rule, p.scope, this.currentRulesVersion());
    return { ok: true };
  }

  // --- 承認済みルール -------------------------------------------------------------

  listRules(): CoachingRule[] {
    const rows = this.db.prepare('SELECT * FROM coaching_rules ORDER BY approved_at, rowid').all() as unknown as RuleRow[];
    return rows.map(toRule);
  }

  getRule(id: string): CoachingRule | null {
    const r = this.db.prepare('SELECT * FROM coaching_rules WHERE rule_id = ?').get(id) as RuleRow | undefined;
    return r ? toRule(r) : null;
  }

  setRuleEnabled(id: string, enabled: boolean): { ok: true; rulesVersion: number } | { ok: false; error: LearningError } {
    const r = this.getRule(id);
    if (!r) return { ok: false, error: 'not_found' };
    const next = enabled ? 'active' : 'disabled';
    if (r.status === next) return { ok: true, rulesVersion: this.currentRulesVersion() };
    if (enabled && this.listRules().filter((x) => x.status === 'active').length >= LEARNING_LIMITS.maxActiveRules) {
      return { ok: false, error: 'too_many_rules' };
    }
    this.mutateRuleSet(() => {
      this.db.prepare('UPDATE coaching_rules SET status = ? WHERE rule_id = ?').run(next, id);
    }, (v) => this.logHistory(id, r.sourceProposalId, enabled ? 'enabled' : 'disabled', r.text, r.scope, v));
    return { ok: true, rulesVersion: this.currentRulesVersion() };
  }

  deleteRule(id: string): { ok: true; rulesVersion: number } | { ok: false; error: LearningError } {
    const r = this.getRule(id);
    if (!r) return { ok: false, error: 'not_found' };
    this.mutateRuleSet(() => {
      this.db.prepare('DELETE FROM coaching_rules WHERE rule_id = ?').run(id);
    }, (v) => this.logHistory(id, r.sourceProposalId, 'deleted', r.text, r.scope, v));
    return { ok: true, rulesVersion: this.currentRulesVersion() };
  }

  /** 次のセッションで使う版と有効ルール（開始時に1回読む。進行中のセッションは変えない）。 */
  activeRuleSet(): ActiveRuleSet {
    return { version: this.currentRulesVersion(), rules: this.listRules().filter((r) => r.status === 'active') };
  }

  currentRulesVersion(): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM rule_sets').get() as { v: number | null };
    return Number(r.v ?? 0);
  }

  historyEntries(): RuleHistoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM rule_history ORDER BY id DESC LIMIT 200').all() as Array<{
      rule_id: string | null;
      proposal_id: string | null;
      action: string;
      text: string;
      scope: string;
      rules_version: number;
      changed_at: number;
    }>;
    return rows.map((r) =>
      RuleHistoryEntry.parse({
        ruleId: r.rule_id,
        proposalId: r.proposal_id,
        action: r.action,
        text: r.text,
        scope: r.scope,
        rulesVersion: r.rules_version,
        changedAt: r.changed_at,
      }),
    );
  }

  private logHistory(
    ruleId: string | null,
    proposalId: string | null,
    action: RuleHistoryAction,
    text: string,
    scope: RuleScope,
    rulesVersion: number,
  ): void {
    this.db
      .prepare('INSERT INTO rule_history (rule_id, proposal_id, action, text, scope, rules_version, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ruleId, proposalId, action, text, scope, rulesVersion, this.now());
  }

  private mutateRuleSet(change: () => void, log: (version: number) => void): void {
    this.db.exec('BEGIN');
    try {
      change();
      const v = this.currentRulesVersion() + 1;
      this.snapshotRuleSet(v);
      log(v);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private snapshotRuleSet(version: number): void {
    const ids = (this.db.prepare("SELECT rule_id FROM coaching_rules WHERE status = 'active' ORDER BY rule_id").all() as Array<{ rule_id: string }>).map(
      (r) => r.rule_id,
    );
    this.db.prepare('INSERT INTO rule_sets (version, rule_ids, created_at) VALUES (?, ?, ?)').run(version, JSON.stringify(ids), this.now());
  }
}

function parseTags(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

function toRule(r: RuleRow): CoachingRule {
  return CoachingRule.parse({
    ruleId: r.rule_id,
    text: r.text,
    scope: r.scope,
    status: r.status,
    approvedAt: r.approved_at,
    version: r.version,
    sourceProposalId: r.source_proposal_id,
  });
}

function toProposal(r: ProposalRow): RuleProposal {
  return RuleProposal.parse({
    proposalId: r.proposal_id,
    rule: r.rule,
    reason: r.reason,
    scope: r.scope,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  });
}
