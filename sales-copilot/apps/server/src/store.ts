import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApprovedFact, type AppliedFactRef, type FactCategory, type FactStatus } from '@sales-copilot/contracts';
import type { FeedbackRating } from '@sales-copilot/contracts';

/**
 * 設定・承認済み条件・最小フィードバックの永続化（node:sqlite, data/ は Git 管理外）。
 * 会話本文・音声・助言本文はここへ保存しない（SPEC §13）。
 */
export interface FactInput {
  category: FactCategory;
  value: string;
  scope: string;
  sourceNote: string;
}

export interface FactHistoryEntry {
  factId: string;
  version: number;
  action: 'created' | 'edited' | 'approved' | 'revoked';
  status: FactStatus;
  category: FactCategory;
  value: string;
  scope: string;
  sourceNote: string;
  approvedAt: number | null;
  changedAt: number;
}

export interface FeedbackRecord {
  adviceId: string;
  rating: FeedbackRating;
  kind: string | null;
  promptVersion: string | null;
  createdAt: number;
}

export type FactError = 'not_found' | 'version_mismatch' | 'already_approved' | 'not_approved';

interface FactRow {
  fact_id: string;
  category: string;
  value: string;
  scope: string;
  source_note: string;
  status: string;
  version: number;
  approved_at: number | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (file !== ':memory:') {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows では無視
      }
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS facts (
        fact_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        value TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_note TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        approved_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        category TEXT NOT NULL,
        value TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_note TEXT NOT NULL,
        approved_at INTEGER,
        changed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_fact_usage (
        session_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, fact_id, version)
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        advice_id TEXT NOT NULL,
        rating TEXT NOT NULL,
        kind TEXT,
        prompt_version TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- facts ---------------------------------------------------------------

  listFacts(): ApprovedFact[] {
    const rows = this.db.prepare('SELECT * FROM facts ORDER BY created_at, fact_id').all() as unknown as FactRow[];
    return rows.map(toFact);
  }

  getFact(factId: string): ApprovedFact | null {
    const row = this.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get(factId) as unknown as FactRow | undefined;
    return row ? toFact(row) : null;
  }

  /** 新規は必ず unverified（SPEC §13: 全項目初期は未確認）。 */
  createFact(input: FactInput): ApprovedFact {
    const now = this.now();
    const factId = `fact_${randomUUID()}`;
    this.db
      .prepare(
        'INSERT INTO facts (fact_id, category, value, scope, source_note, status, version, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
      )
      .run(factId, input.category, input.value, input.scope, input.sourceNote, 'unverified', now, now);
    const fact = this.getFact(factId)!;
    this.history(fact, 'created');
    return fact;
  }

  /** 編集: 内容が変われば旧承認は失効し、新バージョンは unverified（再承認が必要）。 */
  updateFact(factId: string, patch: Partial<FactInput>): { ok: true; fact: ApprovedFact; changed: boolean } | { ok: false; error: FactError } {
    const cur = this.getFact(factId);
    if (!cur) return { ok: false, error: 'not_found' };
    const next = {
      category: patch.category ?? cur.category,
      value: patch.value ?? cur.value,
      scope: patch.scope ?? cur.scope,
      sourceNote: patch.sourceNote ?? cur.sourceNote,
    };
    const changed =
      next.category !== cur.category || next.value !== cur.value || next.scope !== cur.scope || next.sourceNote !== cur.sourceNote;
    if (!changed) return { ok: true, fact: cur, changed: false };
    this.db
      .prepare(
        "UPDATE facts SET category = ?, value = ?, scope = ?, source_note = ?, status = 'unverified', version = version + 1, approved_at = NULL, updated_at = ? WHERE fact_id = ?",
      )
      .run(next.category, next.value, next.scope, next.sourceNote, this.now(), factId);
    const fact = this.getFact(factId)!;
    this.history(fact, 'edited');
    return { ok: true, fact, changed: true };
  }

  /** 承認: 現在のバージョンを見て承認したことを expectedVersion で確認。approvedAt を付け version++。 */
  approveFact(factId: string, expectedVersion: number): { ok: true; fact: ApprovedFact } | { ok: false; error: FactError } {
    const cur = this.getFact(factId);
    if (!cur) return { ok: false, error: 'not_found' };
    if (cur.version !== expectedVersion) return { ok: false, error: 'version_mismatch' };
    if (cur.status === 'approved') return { ok: false, error: 'already_approved' };
    const now = this.now();
    this.db
      .prepare("UPDATE facts SET status = 'approved', approved_at = ?, version = version + 1, updated_at = ? WHERE fact_id = ?")
      .run(now, now, factId);
    const fact = this.getFact(factId)!;
    this.history(fact, 'approved');
    return { ok: true, fact };
  }

  revokeFact(factId: string): { ok: true; fact: ApprovedFact } | { ok: false; error: FactError } {
    const cur = this.getFact(factId);
    if (!cur) return { ok: false, error: 'not_found' };
    if (cur.status !== 'approved') return { ok: false, error: 'not_approved' };
    this.db
      .prepare("UPDATE facts SET status = 'revoked', approved_at = NULL, version = version + 1, updated_at = ? WHERE fact_id = ?")
      .run(this.now(), factId);
    const fact = this.getFact(factId)!;
    this.history(fact, 'revoked');
    return { ok: true, fact };
  }

  factHistory(factId: string): FactHistoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM fact_history WHERE fact_id = ? ORDER BY id').all(factId) as unknown as Array<
      FactRow & { action: string; changed_at: number }
    >;
    return rows.map((r) => ({
      factId: r.fact_id,
      version: r.version,
      action: r.action as FactHistoryEntry['action'],
      status: r.status as FactStatus,
      category: r.category as FactCategory,
      value: r.value,
      scope: r.scope,
      sourceNote: r.source_note,
      approvedAt: r.approved_at,
      changedAt: r.changed_at,
    }));
  }

  /**
   * セッション開始時の適用条件を検証して記録する。承認済みかつ指定バージョンが現行のものだけ通す。
   */
  resolveAppliedFacts(
    sessionId: string,
    refs: readonly AppliedFactRef[],
  ): { ok: true; facts: ApprovedFact[] } | { ok: false; factId: string; error: 'not_found' | 'not_approved' | 'version_mismatch' } {
    const facts: ApprovedFact[] = [];
    for (const ref of refs) {
      const f = this.getFact(ref.factId);
      if (!f) return { ok: false, factId: ref.factId, error: 'not_found' };
      if (f.status !== 'approved') return { ok: false, factId: ref.factId, error: 'not_approved' };
      if (f.version !== ref.version) return { ok: false, factId: ref.factId, error: 'version_mismatch' };
      facts.push(f);
    }
    const now = this.now();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO session_fact_usage (session_id, fact_id, version, applied_at) VALUES (?, ?, ?, ?)');
    for (const f of facts) stmt.run(sessionId, f.factId, f.version, now);
    return { ok: true, facts };
  }

  sessionFactUsage(sessionId: string): AppliedFactRef[] {
    const rows = this.db
      .prepare('SELECT fact_id, version FROM session_fact_usage WHERE session_id = ? ORDER BY fact_id')
      .all(sessionId) as unknown as Array<{ fact_id: string; version: number }>;
    return rows.map((r) => ({ factId: r.fact_id, version: r.version }));
  }

  // --- feedback --------------------------------------------------------------

  /** 既定は最小限（ID・評価・種類・promptVersion・時刻）。会話本文は保存しない。 */
  addFeedback(f: Omit<FeedbackRecord, 'createdAt'>): FeedbackRecord {
    const rec: FeedbackRecord = { ...f, createdAt: this.now() };
    this.db
      .prepare('INSERT INTO feedback (advice_id, rating, kind, prompt_version, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(rec.adviceId, rec.rating, rec.kind, rec.promptVersion, rec.createdAt);
    return rec;
  }

  listFeedback(): FeedbackRecord[] {
    const rows = this.db.prepare('SELECT * FROM feedback ORDER BY id').all() as unknown as Array<{
      advice_id: string;
      rating: string;
      kind: string | null;
      prompt_version: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      adviceId: r.advice_id,
      rating: r.rating as FeedbackRating,
      kind: r.kind,
      promptVersion: r.prompt_version,
      createdAt: r.created_at,
    }));
  }

  private history(f: ApprovedFact, action: FactHistoryEntry['action']): void {
    this.db
      .prepare(
        'INSERT INTO fact_history (fact_id, version, action, status, category, value, scope, source_note, approved_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(f.factId, f.version, action, f.status, f.category, f.value, f.scope, f.sourceNote, f.approvedAt, this.now());
  }
}

function toFact(r: FactRow): ApprovedFact {
  return ApprovedFact.parse({
    factId: r.fact_id,
    category: r.category,
    value: r.value,
    scope: r.scope,
    sourceNote: r.source_note,
    approvedAt: r.approved_at,
    version: r.version,
    status: r.status,
  });
}
