import { currentLocation } from "./detour";
import { haversineM } from "./geo";
import { AREA_LABEL } from "./labels";
import { isInert } from "./schedule";
import type { ReplanEvent } from "./replan";
import type { Itinerary, LatLng, PlanningContext } from "./types";

/**
 * 言葉（「ちょっと疲れた」「雨が降ってきた」「電車が30分遅れてる」「スタバに寄りたい」）を、再計画のイベントに読み替える境界。
 * いまはキーワードによる簡単な実装（keywordEventParser）。LLM に差し替えるときは、同じ形の EventParser を作って
 * src/eventParser.ts で登録する（LLM は呼んでいない）。計算（再計画）はルールベースのまま、言葉の読み取りだけを差し替える。
 *
 * 読み取った結果は、そのまま反映せず、必ず再計画のプレビュー（提案・差分）に通す。
 */

export interface ParseContext {
  itinerary: Itinerary;
  ctx: PlanningContext;
  dayIndex: number;
  /** 現在時刻（0:00 からの分） */
  nowMin: number;
}

export interface ParsedEvent {
  event: ReplanEvent;
  /** 読み取りの根拠にした言葉 */
  matched: string;
  /** 書かれていなくて、こちらで仮定した値（例: 「遅れた」だけなら15分）。画面に出して確認してもらう */
  assumed?: string;
}

export type ParseResult = { ok: true; events: ParsedEvent[] } | { ok: false; reason: string };

export interface EventParser {
  /** 非同期にできるのは、将来 LLM などに差し替えたときのため */
  parse(text: string, c: ParseContext): ParseResult | Promise<ParseResult>;
}

/* ---------- キーワード実装 ---------- */

export const SUPPORTED_WORDS = "疲れた・雨・遅れ・寄りたい";

const TIRED = /疲れ|つかれ|しんどい|ばて|へとへと|くたくた|歩きたくない|歩けない|足が痛|休みたい|休憩|もう無理|限界/;
const TIRED_HEAVY = /かなり|すごく|めちゃ|へとへと|くたくた|もう(無理|だめ|歩けない)|歩けない|限界/;
const RAIN = /雨|降って|降り出|降ってき|傘|土砂降り/;
const RAIN_STOPPED = /(雨|降り).{0,6}((止|や)(んだ|んで|みそう)|止ま)|晴れた|晴れてき/;
// 「止まって」は乗り物が止まったときだけ（「雨が止まって」を遅れと読まない）
const DELAY = /遅れ|遅延|遅刻|押して|(電車|列車|バス|地下鉄|JR|西鉄|線)が?.{0,3}止ま(って|った)|運転見合わせ/;
const DETOUR = /寄りたい|寄り道|寄っていい|寄っていきたい|寄ってみたい|立ち寄/;

/** 全角の数字などを半角にそろえる */
const normalize = (s: string) => s.normalize("NFKC").trim();

/** 遅れの分数。「30分」「1時間」「1時間半」「半時間」。書かれていなければ undefined */
export function parseMinutes(text: string): number | undefined {
  const t = normalize(text);
  const hm = t.match(/(\d+)\s*時間\s*(半|(\d+)\s*分)?/);
  if (hm) return Number(hm[1]) * 60 + (hm[2] === "半" ? 30 : hm[3] ? Number(hm[3]) : 0);
  if (/半時間/.test(t)) return 30;
  const m = t.match(/(\d+)\s*分/);
  return m ? Number(m[1]) : undefined;
}

const DEFAULT_DELAY_MIN = 15;
const MAX_DELAY_MIN = 240;
const DEFAULT_DETOUR_MIN = 30;

/** よくある呼び方 → スポット名に含まれる言葉 */
// 「ラーメン」のような一般的な言葉は、特定の店に決め打ちしない（自由入力の寄り道になる）
const ALIASES: Record<string, string> = { スタバ: "スターバックス", レック: "REC", キャナル: "キャナルシティ" };

/**
 * 文中に書かれたスポットを探す（スポット名の全体、または「（」「 」の前の部分、別名が含まれるもの）。
 * 同じ言葉に当たるスポットが複数あるとき（スターバックスが2店など）は、文中にエリア名（「太宰府の」）があればそのエリア、
 * なければ near（いまいる場所）に近いものを選ぶ。
 */
export function findSpotMention(text: string, ctx: PlanningContext, near?: LatLng): string | undefined {
  // 「太宰府の」「大濠公園の」のようなエリアの修飾は、スポット名の照合から外して、エリアの絞り込みに使う
  let t = normalize(text).replace(/[\s　]/g, "");
  const areas = (Object.keys(AREA_LABEL) as (keyof typeof AREA_LABEL)[]).filter((a) => t.includes(`${AREA_LABEL[a]}の`));
  for (const a of areas) t = t.replace(`${AREA_LABEL[a]}の`, "");
  const hits: { id: string; len: number }[] = [];
  for (const sp of ctx.spots) {
    const full = normalize(sp.name).replace(/[\s　]/g, "");
    const short = normalize(sp.name).split(/[（(\s　]/)[0].replace(/[\s　]/g, "");
    const keys = [full, short, ...Object.entries(ALIASES).filter(([, v]) => full.includes(v)).map(([k]) => k)].filter((k) => k.length >= 3);
    const len = Math.max(0, ...keys.filter((k) => t.includes(k)).map((k) => k.length));
    if (len > 0) hits.push({ id: sp.id, len });
  }
  if (!hits.length) return undefined;
  const best = Math.max(...hits.map((h) => h.len));
  let tied = hits.filter((h) => h.len === best).map((h) => ctx.spotById.get(h.id)!);
  const inArea = tied.filter((sp) => areas.includes(sp.area));
  if (inArea.length) tied = inArea;
  if (near && tied.length > 1) tied = [...tied].sort((a, b) => haversineM(near, a) - haversineM(near, b));
  return tied[0].id;
}

/** 「〇〇に寄りたい」の〇〇（スポットが見つからないときの自由入力の名前） */
function freeDetourName(text: string): string | undefined {
  // 滞在の長さ（「20分ほど」）は名前に入れない
  const t = normalize(text).replace(/\d+\s*(?:分|時間)半?(?:ほど|くらい|ぐらい)?/g, "");
  const m = t.match(/(.+?)(?:に|へ|で)?(?:ちょっと|少し)?(?:寄りたい|寄り道|寄っていい|寄っていきたい|寄ってみたい|立ち寄)/);
  const name = m?.[1]?.replace(/^(あと|それと|で|ここで|この近くの|近くの)/, "").replace(/[、,。\s]+$/g, "").trim();
  return name && name.length <= 30 ? name : undefined;
}

export function parseWithKeywords(text: string, c: ParseContext): ParseResult {
  const t = normalize(text);
  if (!t) return { ok: false, reason: "言葉が入力されていません" };
  const events: ParsedEvent[] = [];
  const unhandled: string[] = [];

  // 遅れ
  const delayWord = t.match(DELAY)?.[0];
  if (delayWord) {
    const minutes = parseMinutes(t);
    const clamped = Math.min(MAX_DELAY_MIN, Math.max(5, minutes ?? DEFAULT_DELAY_MIN));
    events.push({
      event: { type: "delay", minutes: clamped },
      matched: delayWord,
      assumed: minutes === undefined ? `遅れの長さが書かれていないので、${DEFAULT_DELAY_MIN}分と仮定しました` : minutes !== clamped ? `${clamped}分に丸めました` : undefined,
    });
  }

  // 雨（止んだ、は対象外）
  const rainWord = RAIN_STOPPED.test(t) ? undefined : t.match(RAIN)?.[0];
  if (RAIN_STOPPED.test(t)) unhandled.push("雨が止んだことは、読み取れません（切り替えた予定を戻すには、旅程の画面で操作してください）");
  if (rainWord) {
    const day = c.itinerary.days[c.dayIndex];
    const ids = (day?.blocks ?? [])
      .filter((b) => !isInert(b) && !b.fixed && b.planB && !b.switched && b.endMin > c.nowMin && b.actualEndMin === undefined)
      .map((b) => b.id);
    if (ids.length) events.push({ event: { type: "plan-b", blockIds: ids, cause: "rain" }, matched: rainWord });
    else unhandled.push("雨の影響を受ける、Plan B に替えられる屋外の予定は、これから先にありません");
  }

  // 寄りたい
  const detourWord = t.match(DETOUR)?.[0];
  if (detourWord) {
    const day = c.itinerary.days[c.dayIndex];
    const here = day ? currentLocation(c.itinerary, c.ctx, c.dayIndex, c.nowMin) : undefined;
    const spotId = findSpotMention(t, c.ctx, here);
    if (spotId) {
      events.push({ event: { type: "detour", stop: { spotId } }, matched: detourWord });
    } else {
      const name = freeDetourName(t);
      if (name) {
        const minutes = parseMinutes(t);
        const durationMin = Math.min(90, Math.max(10, minutes ?? DEFAULT_DETOUR_MIN));
        events.push({
          event: { type: "detour", stop: { name, durationMin } },
          matched: detourWord,
          assumed: `「${name}」はスポットのデータにないため、自由入力の寄り道にしました。移動は10分と仮定します${minutes === undefined ? `（滞在は${DEFAULT_DETOUR_MIN}分と仮定）` : ""}`,
        });
      } else unhandled.push("どこに寄りたいかが読み取れませんでした");
    }
  }

  // 疲れた
  const tiredWord = t.match(TIRED)?.[0];
  if (tiredWord) {
    events.push({ event: { type: "tired", level: TIRED_HEAVY.test(t) ? "heavy" : "light", source: "member" }, matched: tiredWord });
  }

  if (events.length) return { ok: true, events };
  return { ok: false, reason: unhandled[0] ?? `読み取れませんでした（対応している言葉: ${SUPPORTED_WORDS}）` };
}

/** キーワードによる EventParser。LLM には繋がっていない */
export const keywordEventParser: EventParser = { parse: parseWithKeywords };
