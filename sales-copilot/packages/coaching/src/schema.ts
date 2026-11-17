import { z } from 'zod';
import { AdviceLlmOutputBase } from '@sales-copilot/contracts';

/**
 * Claude structured outputs が受け付けない制約キーワード。
 * 文字数・件数の上限はアプリ側の Zod 検証（AdviceLlmOutput）で必ず再検査する。
 */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYWORDS.has(k)) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return node;
}

let cached: Record<string, unknown> | null = null;

/**
 * AdviceLlmOutputBase（contracts）から導出した出力 JSON Schema。
 * - 全オブジェクト additionalProperties:false / 全フィールド required（.strict() 由来）
 * - 長さ・件数制約は除去（API 非対応）。上限の説明はシステムプロンプトのアプリ側ルールに記載。
 */
/** 任意の Zod スキーマから structured outputs 用 JSON Schema（非対応の制約キーワードを除去）を作る。 */
export function toLlmJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export function adviceOutputJsonSchema(): Record<string, unknown> {
  if (!cached) {
    cached = strip(z.toJSONSchema(AdviceLlmOutputBase)) as Record<string, unknown>;
  }
  return structuredClone(cached);
}
