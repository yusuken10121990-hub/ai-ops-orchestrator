import {
  buildProposalPrompt,
  checkRuleText,
  estimateMaxInputTokens,
  parseProposalOutput,
  PROPOSAL_MAX_OUTPUT_TOKENS,
  RULE_TEXT_PROBLEM_MESSAGE,
} from '@sales-copilot/coaching';
import {
  LEARNING_LIMITS,
  LearningOkResponse,
  LearningOverviewResponse,
  LearningSettingsPatch,
  ProposalApproveRequest,
  ProposalEstimateResponse,
  ProposalGenerateResponse,
  RuleResponse,
  type LearningErrorCode,
} from '@sales-copilot/contracts';
import type { AdviceLlm } from '@sales-copilot/providers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ServerConfig } from './config';
import type { LearningError } from './learning-store';
import type { Store } from './store';

export interface LearningRouteDeps {
  config: ServerConfig;
  logger: Logger;
  store: Store;
  /** 改善案づくり用の LLM（助言と同じキー・モデル）。未設定なら null。 */
  proposalLlm: AdviceLlm | null;
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const PROPOSAL_TIMEOUT_MS = 45_000;

function fail(reply: FastifyReply, status: number, error: LearningErrorCode, message?: string) {
  return reply.code(status).send({ error, ...(message ? { message } : {}) });
}

function storeError(reply: FastifyReply, e: LearningError) {
  if (e === 'not_found') return fail(reply, 404, 'not_found');
  if (e === 'too_many_rules') return fail(reply, 409, 'too_many_rules', `有効にできるルールは${LEARNING_LIMITS.maxActiveRules}件までです。不要なルールを止めてください`);
  return fail(reply, 409, 'already_decided');
}

/**
 * 学習（承認制）の HTTP。全て settings スコープ（options 画面だけが使う）。
 * - 改善案は提案として保存するだけ。承認されるまで助言には一切使わない。
 * - 承認・停止・削除はルール全体の版（rulesVersion）を上げ、次のセッションから効く。
 * - ログに提案文・カード文面は出さない（件数だけ）。
 */
export function registerLearningRoutes(app: FastifyInstance, d: LearningRouteDeps): void {
  const { store, logger, config } = d;
  const L = store.learning;
  const opts = { preHandler: d.preHandler };

  app.get('/learning', opts, async () =>
    LearningOverviewResponse.parse({
      settings: L.settings(),
      rulesVersion: L.currentRulesVersion(),
      rules: L.listRules(),
      proposals: L.pendingProposals(),
      history: L.historyEntries(),
      stats: L.stats(),
      samplesWithText: L.samplesWithTextCount(),
      newSamplesSinceLastProposal: L.samplesWithTextCount(L.lastProposalAt()),
    }),
  );

  app.patch('/learning/settings', opts, async (req, reply) => {
    const p = LearningSettingsPatch.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'invalid_body');
    return L.updateSettings(p.data);
  });

  const prepare = () => {
    const samples = L.ratedSamples();
    const prompt = buildProposalPrompt({ samples, activeRules: L.listRules().filter((r) => r.status === 'active') });
    return { samples, prompt };
  };

  app.post('/learning/proposals/estimate', opts, async () => {
    const { samples, prompt } = prepare();
    const maxInputTokens = estimateMaxInputTokens(prompt);
    const pt = config.priceTable;
    const maxCost =
      pt && pt.llmInputPerMTok !== null && pt.llmOutputPerMTok !== null
        ? {
            amount: (maxInputTokens / 1e6) * pt.llmInputPerMTok + (PROPOSAL_MAX_OUTPUT_TOKENS / 1e6) * pt.llmOutputPerMTok,
            currency: pt.currency,
            priceSource: pt.source,
            priceCheckedDate: pt.checkedDate,
          }
        : null;
    return ProposalEstimateResponse.parse({
      configured: d.proposalLlm !== null,
      model: config.anthropic.model,
      sampleCount: samples.length,
      enoughSamples: samples.length >= LEARNING_LIMITS.minSamplesForProposal,
      maxInputTokens,
      maxOutputTokens: PROPOSAL_MAX_OUTPUT_TOKENS,
      maxCost,
    });
  });

  app.post('/learning/proposals/generate', opts, async (_req, reply) => {
    if (!d.proposalLlm) return fail(reply, 503, 'not_configured', 'ANTHROPIC_API_KEY を .env に設定してサーバーを起動し直してください');
    const { samples, prompt } = prepare();
    if (samples.length < LEARNING_LIMITS.minSamplesForProposal) {
      return fail(
        reply,
        409,
        'not_enough_samples',
        `評価が${LEARNING_LIMITS.minSamplesForProposal}件以上必要です（今${samples.length}件）。商談中にカードの「役立った」「ずれた」を押してください`,
      );
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROPOSAL_TIMEOUT_MS);
    let text: string;
    try {
      const res = await d.proposalLlm.complete({ ...prompt, maxOutputTokens: PROPOSAL_MAX_OUTPUT_TOKENS, signal: ctrl.signal });
      text = res.text;
    } catch (e) {
      logger.warn({ kind: (e as { kind?: string }).kind ?? 'unknown' }, 'learning proposal generation failed');
      return fail(reply, 502, 'llm_failed', '改善案を作れませんでした。少し待ってからもう一度押してください');
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseProposalOutput(text, {
      existingRuleTexts: [...L.listRules().map((r) => r.text), ...L.pendingProposals().map((p) => p.rule)],
    });
    if (!parsed.ok) {
      logger.warn({ error: parsed.error }, 'learning proposal output rejected');
      return fail(reply, 502, 'llm_failed', '改善案の形が不正だったため表示しません。もう一度押してください');
    }
    L.markProposalRun();
    const proposals = L.addProposals(parsed.proposals);
    logger.info({ samples: samples.length, proposals: proposals.length, dropped: parsed.dropped }, 'learning proposals generated');
    return ProposalGenerateResponse.parse({ proposals, dropped: parsed.dropped });
  });

  app.post<{ Params: { id: string } }>('/learning/proposals/:id/approve', opts, async (req, reply) => {
    const p = ProposalApproveRequest.safeParse(req.body ?? {});
    if (!p.success) return fail(reply, 400, 'invalid_body', `ルールは${LEARNING_LIMITS.ruleText}文字以内の1文にしてください`);
    const cur = L.getProposal(req.params.id);
    if (!cur) return fail(reply, 404, 'not_found');
    // 編集あり・なしどちらも、保存前にルール文をもう一度検査する（承認済み条件を上書きさせない）
    const checked = checkRuleText(p.data.text ?? cur.rule);
    if (!checked.ok) return fail(reply, 422, 'rule_rejected', RULE_TEXT_PROBLEM_MESSAGE[checked.problem]);
    const r = L.approveProposal(req.params.id, { text: checked.text, scope: p.data.scope });
    if (!r.ok) return storeError(reply, r.error);
    logger.info({ rulesVersion: r.rulesVersion }, 'learning rule approved');
    return RuleResponse.parse({ rule: r.rule, rulesVersion: r.rulesVersion });
  });

  app.post<{ Params: { id: string } }>('/learning/proposals/:id/reject', opts, async (req, reply) => {
    const r = L.rejectProposal(req.params.id);
    if (!r.ok) return storeError(reply, r.error);
    return LearningOkResponse.parse({ ok: true, rulesVersion: L.currentRulesVersion() });
  });

  for (const [path, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/learning/rules/:id/${path}`, opts, async (req, reply) => {
      const r = L.setRuleEnabled(req.params.id, enabled);
      if (!r.ok) return storeError(reply, r.error);
      return LearningOkResponse.parse({ ok: true, rulesVersion: r.rulesVersion });
    });
  }

  app.post<{ Params: { id: string } }>('/learning/rules/:id/delete', opts, async (req, reply) => {
    const r = L.deleteRule(req.params.id);
    if (!r.ok) return storeError(reply, r.error);
    return LearningOkResponse.parse({ ok: true, rulesVersion: r.rulesVersion });
  });

  app.post('/learning/wipe', opts, async () => {
    L.wipeLearningData();
    logger.info('learning data wiped');
    return LearningOkResponse.parse({ ok: true, rulesVersion: L.currentRulesVersion() });
  });
}
