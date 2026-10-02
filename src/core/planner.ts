import { findOpenSlot, isOpenOnDate, overlapsCrowded } from "./availability";
import { addDays } from "./time";
import { attachPlanBs, needsPlanB } from "./planb";
import { baseScore, SCORE_WEIGHTS } from "./scoring";
import { commitBaseline, recomputeDay } from "./schedule";
import type {
  Block,
  Day,
  GenerateInput,
  InterestCategory,
  Itinerary,
  ItineraryGenerator,
  LatLng,
  MealSlot,
  Origin,
  Pace,
  PlanningContext,
  Preferences,
  Spot,
  TravelEstimate,
} from "./types";

/* ---------- ペース設定 ---------- */

interface PaceConfig {
  /** 1日の開始時刻 */
  startMin: number;
  /** 日帰り・1泊2日の1日目の終了時刻 */
  dayEndMin: number;
  /** 1泊2日の最終日の終了時刻 */
  lastDayEndMin: number;
  /** 1日あたりの（食事を除く）スポット数の目安 */
  maxSpots: number;
  /** 余白ブロックの長さ・挿入間隔・最大数 */
  restLen: number;
  restEvery: number;
  maxRests: number;
  /** 開店まで待ってよい最大時間（Must 以外） */
  maxWait: number;
  /** 滞在時間の倍率。ゆったりは長く、詰め込みは短く */
  stayFactor: number;
}

/** ゆったりほど余白が多く・長く、スポット数は少ない */
export const PACE_CONFIG: Record<Pace, PaceConfig> = {
  relaxed: { startMin: 10 * 60, dayEndMin: 20 * 60, lastDayEndMin: 16 * 60, maxSpots: 3, restLen: 45, restEvery: 120, maxRests: 3, maxWait: 40, stayFactor: 1.25 },
  normal: { startMin: 9 * 60 + 30, dayEndMin: 20 * 60 + 30, lastDayEndMin: 17 * 60, maxSpots: 4, restLen: 30, restEvery: 180, maxRests: 2, maxWait: 40, stayFactor: 1 },
  packed: { startMin: 9 * 60, dayEndMin: 21 * 60 + 30, lastDayEndMin: 18 * 60, maxSpots: 6, restLen: 15, restEvery: 240, maxRests: 1, maxWait: 30, stayFactor: 0.85 },
};

/** 食事枠。earliest 以降、latest（開始時刻の上限）までに入れる */
export const MEAL_WINDOW: Record<MealSlot, { earliest: number; latest: number }> = {
  lunch: { earliest: 11 * 60 + 30, latest: 13 * 60 + 45 },
  dinner: { earliest: 17 * 60 + 30, latest: 19 * 60 + 30 },
};

/** 移動1分あたりの減点。遠いスポットは「寄り道」にならないよう強めにする */
const TRAVEL_PENALTY_PER_MIN = 0.1;
/** 直前のスポットと同じエリアのときの加点（エリアをあちこち行き来しないように） */
const SAME_AREA_BONUS = 0.8;
const WAIT_PENALTY_PER_MIN = 0.02;
/** その日まだ屋外・半屋外の予定がないときの加点（屋内ばかりの1日にならないよう変化を付ける） */
const OUTDOOR_VARIETY_BONUS = 1.2;
const SEMI_VARIETY_BONUS = 0.4;
/** 次の食事までこれ以上空くときは、ペースの上限を超えてでもスポットを1つ足す（長い空白を避ける） */
const FILLER_GAP_MIN = 150;
/** 食事枠が始まるまでの待ち時間として許容する長さ。これより長く空くならスポットを足す */
const MEAL_SHORT_WAIT_MIN = 45;

/** 食事に出かけてよい移動時間の上限（Must 以外） */
const MEAL_MAX_TRAVEL_MIN = 35;
/** 通常スポットの移動時間の上限は max(これ, 滞在時間)。滞在より長く移動する寄り道は避ける */
const MIN_TRAVEL_CAP_MIN = 25;

const NIGHTVIEW_EARLIEST = 17 * 60 + 30;
const MUST_MAX_WAIT = 150;
const MIN_REST_GAP_FOR_BLOCK = 15; // これ以上の待ち時間は「余白」ブロックにする

export const DAY_ORIGINS: Origin[] = [
  { name: "博多駅", lat: 33.5898, lng: 130.4207 },
  { name: "宿泊先（天神）", lat: 33.5905, lng: 130.3995 },
];

/* ---------- 候補の評価 ---------- */

interface Eval {
  start: number;
  end: number;
  stay: number;
  travel: TravelEstimate;
  wait: number;
}

interface EvalOpts {
  earliest?: number;
  latestStart?: number;
  dayEnd: number;
  maxWait: number;
  /** これを超える移動は寄り道とみなして候補にしない（Must には適用しない） */
  maxTravel?: number;
  /** ペースで調整した滞在時間 */
  stay: number;
}

function categoryEarliest(spot: Spot): number {
  return spot.category === "nightview" ? NIGHTVIEW_EARLIEST : 0;
}

function evaluate(ctx: PlanningContext, date: string, spot: Spot, t: number, loc: LatLng, o: EvalOpts): Eval | null {
  const travel = ctx.travel(loc, spot);
  if (o.maxTravel !== undefined && travel.minutes > o.maxTravel) return null;
  const arrival = t + travel.minutes;
  const earliest = Math.max(arrival, o.earliest ?? 0, categoryEarliest(spot));
  const slot = findOpenSlot(spot, date, earliest, o.stay);
  if (!slot) return null;
  const start = slot.start;
  if (o.latestStart !== undefined && start > o.latestStart) return null;
  const end = start + o.stay;
  if (end > o.dayEnd) return null;
  const wait = start - arrival;
  if (wait > o.maxWait) return null;
  return { start, end, stay: o.stay, travel, wait };
}

function timeFit(spot: Spot, start: number): number {
  let s = 0;
  if (spot.category === "cafe" && start >= 14 * 60 && start <= 17 * 60 + 30) s += 0.6;
  if (spot.category === "nightview" && start >= NIGHTVIEW_EARLIEST) s += 0.8;
  if (spot.setting !== "indoor" && spot.category !== "nightview" && start >= 18 * 60) s -= 1.0;
  if (spot.category === "shopping" && start >= 19 * 60) s -= 0.5;
  return s;
}

/* ---------- Must の日割り ---------- */

interface DayDef {
  index: number;
  date: string;
  startMin: number;
  endMin: number;
  origin: Origin;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** Must スポットをエリア単位でまとめ、滞在時間が偏らないように各日へ割り当てる */
function assignMusts(musts: Spot[], defs: DayDef[]): { perDay: Spot[][]; warnings: string[] } {
  const perDay: Spot[][] = defs.map(() => []);
  const load = defs.map(() => 0);
  const warnings: string[] = [];

  const groups = new Map<string, Spot[]>();
  for (const s of musts) groups.set(s.area, [...(groups.get(s.area) ?? []), s]);
  const ordered = [...groups.values()].sort(
    (a, b) => b.reduce((n, s) => n + s.stayMin, 0) - a.reduce((n, s) => n + s.stayMin, 0),
  );

  const place = (spots: Spot[]): boolean => {
    const eligible = defs.filter((d) => spots.every((s) => isOpenOnDate(s, d.date)));
    if (!eligible.length) return false;
    const target = eligible.reduce((best, d) => (load[d.index] < load[best.index] ? d : best), eligible[0]);
    perDay[target.index].push(...spots);
    load[target.index] += spots.reduce((n, s) => n + s.stayMin, 0);
    return true;
  };

  for (const group of ordered) {
    if (place(group)) continue;
    for (const s of group) {
      if (!place([s])) {
        const days = s.closedDays?.map((d) => WEEKDAY_JA[d]).join("・");
        warnings.push(`「${s.name}」は定休日（${days}曜）のため、この日程には入れられませんでした。`);
      }
    }
  }
  return { perDay, warnings };
}

/* ---------- 1日分の生成 ---------- */

interface Placed {
  block: Block;
  score: number;
  isMeal: boolean;
  isMust: boolean;
}

function planDay(
  def: DayDef,
  ctx: PlanningContext,
  prefs: Preferences,
  pace: PaceConfig,
  dayMusts: Spot[],
  userMustIds: ReadonlySet<string>,
  used: Set<string>,
): { blocks: Block[]; warnings: string[] } {
  const warnings: string[] = [];
  const mustIds = new Set(dayMusts.map((s) => s.id));
  const cap = Math.max(pace.maxSpots, dayMusts.length);
  if (dayMusts.length > pace.maxSpots) {
    warnings.push(`行きたい場所が多いため、この日は選んだペースより詰まった予定になっています。`);
  }

  let t = def.startMin;
  let loc: LatLng = def.origin;
  let lastArea: Spot["area"] | null = null;
  const placed: Placed[] = [];
  const catCount = new Map<InterestCategory, number>();
  let nonMeal = 0;
  let hasOutdoor = false;
  let restsUsed = 0;
  let lastRestEnd = def.startMin;
  let seq = 0;
  const nextId = () => `d${def.index + 1}b${++seq}`;
  /** ペースに合わせた滞在時間（5分単位） */
  const stayOf = (spot: Spot) => Math.max(15, Math.round((spot.stayMin * pace.stayFactor) / 5) * 5);

  const mealPending: Record<MealSlot, boolean> = {
    lunch: def.startMin < MEAL_WINDOW.lunch.latest && def.endMin > MEAL_WINDOW.lunch.earliest + 60,
    dinner: def.endMin >= MEAL_WINDOW.dinner.latest,
  };
  const nextMeal = (): MealSlot | null => (mealPending.lunch ? "lunch" : mealPending.dinner ? "dinner" : null);

  const placeBuffer = (len: number) => {
    const prev = placed[placed.length - 1];
    if (prev && prev.block.label === "buffer") {
      // 余白が続くときは1つにまとめる
      prev.block.durationMin += len;
      prev.block.endMin += len;
      t += len;
      lastRestEnd = t;
      return;
    }
    placed.push({
      block: { id: nextId(), label: "buffer", durationMin: len, startMin: t, endMin: t + len, travelMin: 0, travelMode: "none" },
      score: 0,
      isMeal: false,
      isMust: false,
    });
    t += len;
    lastRestEnd = t;
  };

  const placeSpot = (spot: Spot, ev: Eval, score: number, isMeal: boolean) => {
    if (ev.wait >= MIN_REST_GAP_FOR_BLOCK) placeBuffer(ev.wait);
    const isMust = userMustIds.has(spot.id);
    placed.push({
      block: {
        id: nextId(),
        label: isMust ? "must" : "normal",
        spotId: spot.id,
        durationMin: ev.stay,
        startMin: ev.start,
        endMin: ev.end,
        travelMin: ev.travel.minutes,
        travelMode: ev.travel.mode,
      },
      score,
      isMeal,
      isMust,
    });
    used.add(spot.id);
    t = ev.end;
    loc = spot;
    lastArea = spot.area;
    if (spot.setting === "outdoor") hasOutdoor = true;
    if (!isMeal) {
      nonMeal++;
      catCount.set(spot.category, (catCount.get(spot.category) ?? 0) + 1);
    }
  };

  const tryMeal = (slot: MealSlot, maxWait: number): boolean => {
    const w = MEAL_WINDOW[slot];
    let best: { spot: Spot; ev: Eval; v: number } | null = null;
    for (const spot of ctx.spots) {
      if (used.has(spot.id) || !spot.mealSlots?.includes(slot)) continue;
      const ev = evaluate(ctx, def.date, spot, t, loc, {
        earliest: w.earliest,
        latestStart: w.latest,
        dayEnd: def.endMin,
        maxWait,
        maxTravel: mustIds.has(spot.id) ? undefined : MEAL_MAX_TRAVEL_MIN,
        stay: stayOf(spot),
      });
      if (!ev) continue;
      // 食事は枠まで待つのが自然なので、待ち時間の減点はごく小さくする
      let v = baseScore(spot, prefs) - TRAVEL_PENALTY_PER_MIN * ev.travel.minutes - 0.005 * ev.wait;
      if (mustIds.has(spot.id)) v += SCORE_WEIGHTS.must;
      if (overlapsCrowded(spot, ev.start, ev.end)) v -= 0.4;
      if (spot.area === lastArea) v += SAME_AREA_BONUS;
      if (slot === "dinner" && spot.mealSlots.length === 1) v += 2.0; // 夜だけの体験（屋台など）
      if (!best || v > best.v + 1e-9) best = { spot, ev, v };
    }
    if (!best) return false;
    placeSpot(best.spot, best.ev, best.v, true);
    mealPending[slot] = false;
    return true;
  };

  const bestNormal = (pendingMeal: MealSlot | null, allowOneExtra: boolean) => {
    if (nonMeal >= cap + (allowOneExtra ? 1 : 0)) return null;
    let best: { spot: Spot; ev: Eval; v: number; total: number } | null = null;
    for (const spot of ctx.spots) {
      if (used.has(spot.id)) continue;
      const isMust = mustIds.has(spot.id);
      if (spot.mealSlots && !isMust) continue; // 食事向けスポットは食事枠で使う
      const ev = evaluate(ctx, def.date, spot, t, loc, {
        dayEnd: def.endMin,
        maxWait: isMust ? MUST_MAX_WAIT : pace.maxWait,
        maxTravel: isMust ? undefined : Math.max(MIN_TRAVEL_CAP_MIN, spot.stayMin),
        stay: stayOf(spot),
      });
      if (!ev) continue;
      if (pendingMeal && ev.end + 10 > MEAL_WINDOW[pendingMeal].latest) continue; // 食事の時間を押さない
      let v = baseScore(spot, prefs);
      v -= SCORE_WEIGHTS.categoryRepeat * (catCount.get(spot.category) ?? 0);
      v -= TRAVEL_PENALTY_PER_MIN * ev.travel.minutes + WAIT_PENALTY_PER_MIN * ev.wait;
      if (overlapsCrowded(spot, ev.start, ev.end)) v -= 0.8;
      v += timeFit(spot, ev.start);
      if (spot.area === lastArea) v += SAME_AREA_BONUS;
      if (!hasOutdoor && prefs.rainTolerance !== "no-outdoor" && ev.start < 17 * 60) {
        if (spot.setting === "outdoor") v += OUTDOOR_VARIETY_BONUS;
        else if (spot.setting === "semi") v += SEMI_VARIETY_BONUS;
      }
      const total = v + (isMust ? SCORE_WEIGHTS.must : 0);
      if (!best || total > best.total + 1e-9) best = { spot, ev, v, total };
    }
    return best;
  };

  const maybeRest = () => {
    if (restsUsed >= pace.maxRests) return;
    if (t - lastRestEnd < pace.restEvery) return;
    if (def.endMin - t < pace.restLen + 60) return;
    const meal = nextMeal();
    if (meal) {
      // 食事まで間がないなら、その待ち時間が余白になる。まだ余裕があるなら先にスポットを入れる
      if (MEAL_WINDOW[meal].earliest - t < FILLER_GAP_MIN) return;
    }
    placeBuffer(pace.restLen);
    restsUsed++;
  };

  for (let guard = 0; guard < 40; guard++) {
    if (t >= def.endMin - 20) break;
    const meal = nextMeal();

    if (meal && t >= MEAL_WINDOW[meal].earliest - 15) {
      if (!tryMeal(meal, MEAL_SHORT_WAIT_MIN)) {
        mealPending[meal] = false;
        warnings.push(`${meal === "lunch" ? "ランチ" : "ディナー"}に使える営業中の店が見つかりませんでした。`);
      }
      maybeRest();
      continue;
    }

    const gapToMeal = meal ? MEAL_WINDOW[meal].earliest - t : 0;
    const best = bestNormal(meal, gapToMeal > FILLER_GAP_MIN);
    if (best) {
      placeSpot(best.spot, best.ev, best.v, false);
      maybeRest();
      continue;
    }

    if (meal) {
      // もう入れるスポットがない。短い待ちで食事に行けるなら食事へ、待ちが長いならスポットを追加で探す
      if (tryMeal(meal, MEAL_SHORT_WAIT_MIN)) { maybeRest(); continue; }
      const filler = bestNormal(meal, true);
      if (filler) { placeSpot(filler.spot, filler.ev, filler.v, false); maybeRest(); continue; }
      if (tryMeal(meal, 180)) { maybeRest(); continue; }
      mealPending[meal] = false;
      warnings.push(`${meal === "lunch" ? "ランチ" : "ディナー"}に使える営業中の店が見つかりませんでした。`);
      continue;
    }
    break;
  }

  // Must を入れられなかったときの警告
  for (const s of dayMusts) {
    if (!used.has(s.id)) warnings.push(`「${s.name}」を時間内に組み込めませんでした（営業時間・移動時間の都合）。`);
  }

  // Optional: Must 以外のスポット（食事を除く）のうち、スコアの低い下位 1/3
  const candidates = placed.filter((p) => !p.isMeal && !p.isMust && p.block.label === "normal");
  if (candidates.length >= 3) {
    const k = Math.max(1, Math.floor(candidates.length / 3));
    const lowest = [...candidates]
      .sort((a, b) => a.score - b.score || placed.indexOf(b) - placed.indexOf(a))
      .slice(0, k);
    for (const p of lowest) p.block.label = "optional";
  }

  return { blocks: placed.map((p) => p.block), warnings };
}

/* ---------- 旅程全体 ---------- */

/** ルールベースの旅程生成。LLM 等に差し替える場合は ItineraryGenerator と同じ形の関数を渡す */
export const generateItinerary: ItineraryGenerator = (input: GenerateInput): Itinerary => {
  const { prefs, ctx, startDate } = input;
  const dayCount = prefs.duration === "overnight" ? 2 : 1;
  const pace = PACE_CONFIG[prefs.pace];

  const defs: DayDef[] = Array.from({ length: dayCount }, (_, i) => ({
    index: i,
    date: addDays(startDate, i),
    startMin: pace.startMin,
    endMin: dayCount > 1 && i === dayCount - 1 ? pace.lastDayEndMin : pace.dayEndMin,
    origin: DAY_ORIGINS[Math.min(i, DAY_ORIGINS.length - 1)],
  }));

  const musts = prefs.mustSpotIds
    .map((id) => ctx.spotById.get(id))
    .filter((s): s is Spot => !!s);
  const userMustIds = new Set(musts.map((s) => s.id));
  const { perDay, warnings: mustWarnings } = assignMusts(musts, defs);

  const used = new Set<string>();
  const days: Day[] = defs.map((def) => {
    const { blocks, warnings } = planDay(def, ctx, prefs, pace, perDay[def.index], userMustIds, used);
    const day: Day = {
      index: def.index,
      date: def.date,
      startMin: def.startMin,
      endMin: def.endMin,
      origin: def.origin,
      blocks,
      warnings: def.index === 0 ? [...mustWarnings, ...warnings] : warnings,
    };
    return commitBaseline(recomputeDay(day, ctx, { mode: "preserve" }));
  });

  let itin: Itinerary = {
    version: 1,
    id: input.id ?? "trip",
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    startDate,
    prefs,
    days,
    closedSpotIds: [],
  };
  return attachPlanBs(itin, ctx);
};

/** Plan B が見つからなかった屋外ブロックの警告文（表示のたびに現在の旅程から導出する） */
export function planBWarnings(day: Day, ctx: PlanningContext): string[] {
  return day.blocks
    .filter((b) => needsPlanB(b, ctx) && b.planB === null)
    .map((b) => `「${ctx.spotById.get(b.spotId!)!.name}」には、雨の日の代わり（Plan B）が見つかりませんでした。`);
}
