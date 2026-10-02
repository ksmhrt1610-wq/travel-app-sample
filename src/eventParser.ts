import { keywordEventParser, type EventParser } from "@/core/parser";

/**
 * ★ 言葉 → 再計画イベントの差し替えポイント ★
 * いまはキーワード（core/parser.ts）。LLM などに変える場合は、EventParser と同じ形のものをここで export する。
 * 読み取った結果は、必ず再計画のプレビュー（差分・提案）を通して反映する。
 */
export const eventParser: EventParser = keywordEventParser;
