# packages/coaching

助言生成の中身を担う。`prompts/system-prompt.ja.md`（SPEC §10 の原文・改変しない）を読み込み、会話ウィンドウ・構造化メモ・承認済み条件・野中専用の補正ルールから LLM 入力を組み立てる。LLM 出力を `@sales-copilot/contracts` の AdviceLlmOutput で検証し、未確認の数値・保証の新規約束、承認済み条件との矛盾、顧客の拒否や未解決の疑問の無視を表示前に検査して、不合格時は有限の再試行か「確認してお伝えする」へ安全に切り替える。promptVersion を管理する。
