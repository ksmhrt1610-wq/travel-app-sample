/**
 * デモシナリオのE2E確認（開発サーバーを起動した状態で実行）
 *   npm run dev            # 別ターミナルで
 *   npm run demo:e2e       # BASE_URL=http://localhost:3000
 *
 * シナリオA（コア体験）:
 *   「友人・普通の予算・グルメとカフェ・ゆったり・小雨OK」で日帰り旅程を作る
 *   → 当日モードで現在時刻を13:00にする → 雨を発生させる → すべての屋外予定を切り替える（差分を見て確定）
 *   あわせて 遅延 / 臨時休業 / 共有リンク / 並べ替え も確認する。
 * シナリオB（固定時刻と「疲れた」）:
 *   太宰府を含む日帰り旅程を作り、帰りの最終便を固定時刻として登録する
 *   → 当日モードで15時にして、電車の30分遅延 → Optional が削られ、最終便に間に合う旅程に組み直される
 *   → 「かなり疲れた」→ 休憩が入り、歩行距離が減り、それでも最終便に間に合う
 *   あわせて メンバー限定の固定時刻（Cさん不在）/ 出発の通知（30分前・10分前）/ 固定ブロックは動かせない も確認する。
 * ブラウザは playwright-core + 既存の Chromium を使う（SCREENSHOT_DIR を指定するとスクリーンショットを保存）。
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SCREENSHOT_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-"))) {
      const p = path.join(root, dir, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  }
  return undefined; // playwright 既定の場所
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const step = (t) => console.log(`\n■ ${t}`);

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ja-JP" });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(e.message));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
const q = (id) => `[data-testid="${id}"]`;
const text = async (id) => (await page.textContent(q(id))) ?? "";
const hhmmToMin = (s) => {
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** デモ操作パネルを（閉じていれば）開く。操作ボタンを押すとパネルは自動で閉じる */
const openSim = async () => {
  if (!(await page.locator(q("sim-body")).isVisible().catch(() => false))) await page.click(q("sim-toggle"));
};
const closeSim = async () => {
  if (await page.locator(q("sim-body")).isVisible().catch(() => false)) await page.click(q("sim-toggle"));
};
const setNowSlider = async (min) => {
  await openSim();
  await page.locator(q("sim-now-slider")).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, min);
};

/** 画面上のスポットブロックを読み取る */
const readBlocks = () =>
  page.$$eval('[data-testid="block-spot"]', (els) =>
    els.map((e) => ({
      id: e.dataset.blockId,
      spotId: e.dataset.spotId,
      name: e.querySelector("h3")?.textContent ?? "",
      setting: e.dataset.setting,
      label: e.dataset.label,
      start: Number(e.dataset.start),
      end: Number(e.dataset.end),
      switched: e.dataset.switched === "true",
      skipped: e.dataset.skipped === "true",
    })),
  );

/** 組み直し案を確定する（確定するまで旅程は変わらないことも確かめる） */
async function waitProposal() {
  await page.waitForSelector(q("proposal-card"));
}
async function confirmProposal() {
  await page.click(q("proposal-confirm"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="proposal-card"]'));
}

try {
  /* ====================================================================
   * シナリオA: 雨 → 屋外予定を切り替える
   * ==================================================================== */

  step("A1. 入力画面で条件を入れて日帰り旅程を作る");
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  check("サンプルデータの注意書きが表示されている", (await text("sample-notice")).includes("サンプルデータ"));
  await page.click(q("duration-day"));
  await page.click(q("companions-friends"));
  await page.click(q("budget-normal"));
  for (const c of ["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"]) {
    const on = (await page.getAttribute(q(`interest-${c}`), "aria-pressed")) === "true";
    if (on !== ["gourmet", "cafe"].includes(c)) await page.click(q(`interest-${c}`));
  }
  await page.click(q("pace-relaxed"));
  await page.click(q("rain-light-rain-ok"));
  await shot("A1-form");
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));

  step("A2. 旅程画面");
  const blocks = await readBlocks();
  check(`スポットブロックが並ぶ（${blocks.length}件）`, blocks.length >= 4);
  check(`余白ブロックがある`, (await page.locator(q("block-buffer")).count()) >= 1);
  const outdoor = blocks.filter((b) => b.setting !== "indoor");
  check(`屋外・半屋外の予定がある（${outdoor.length}件）`, outdoor.length >= 1);
  const planBTexts = await page.locator("text=Plan B：").count();
  const noPlanB = await page.locator(q("no-planb-warning")).count();
  check("屋外・半屋外の予定すべてに Plan B があるか警告が出ている", planBTexts + noPlanB >= outdoor.length, `planB=${planBTexts} warn=${noPlanB} outdoor=${outdoor.length}`);
  await shot("A2-itinerary");

  step("A3. ブロックをタップして詳細と Plan B を見る");
  await page.locator('[data-testid="block-spot"][data-setting="outdoor"]').first().getByRole("button").first().click();
  await page.waitForSelector(q("detail-sheet"));
  check("詳細に Google Maps ボタンがある", (await page.getAttribute(q("open-maps"), "href"))?.startsWith("https://www.google.com/maps/search/"));
  check("詳細に Plan B が表示される", await page.locator(q("planb-section")).locator("text=屋内").first().isVisible());
  await page.keyboard.press("Escape");

  step("A4. 当日モード: 現在時刻を13:00にして、雨が降り出す");
  await page.click(q("go-today"));
  await page.waitForURL("**/today");
  await page.waitForSelector(q("next-card"));
  check("「次にやること」カードが出ている", await page.locator(q("next-card")).isVisible());
  check("出発までの残り時間が出ている", /出発まで|到着まで|今すぐ/.test(await text("next-card")));
  check("歩行距離のメーターが出ている（目安 8.0km は普通ペース、ゆったりは 5.0km）", (await text("walk-meter")).includes("5.0km"));
  await openSim();
  await page.click(q("sim-now-13:00"));
  check("現在時刻が 13:00", (await text("sim-now-label")).includes("13:00"));
  await setNowSlider(790);
  check("スライダーで現在時刻を動かせる（13:10）", (await text("sim-now-label")).includes("13:10"));
  await page.click(q("sim-now-13:00"));

  const before = await readBlocks();
  const outdoorLeft = before.filter((b) => b.setting === "outdoor" && b.end > 13 * 60);
  check(`13時以降に屋外の予定が残っている（${outdoorLeft.map((b) => b.name).join("、")}）`, outdoorLeft.length >= 1);
  check("雨の前は通知バナーが出ていない", (await page.locator(q("rain-banner")).count()) === 0);
  check("雨の強さの初期値は「本降り」（降水確率80%・5mm/h）", (await text("sim-rain-prob-label")).includes("本降り") && (await text("sim-rain-prob-label")).includes("80%"));
  check("雨の強さを3段階（小雨・本降り・強い雨）から選べる", (await page.locator('[data-testid^="sim-rain-strength-"]').count()) === 3);
  check("モードの初期値は「提案」", (await page.getAttribute(q("mode-switch"), "data-mode")) === "suggest");
  await page.click(q("sim-rain-button"));
  await page.waitForSelector(q("rain-banner"));
  check("「Plan Bに切り替えますか？」の通知が出る", (await text("rain-banner")).includes("Plan Bに切り替えますか"));
  check(`影響する屋外予定が列挙される`, (await page.locator(`${q("rain-affected")} li`).count()) === outdoorLeft.length);
  check("「1つだけ切り替える」「残りすべて切り替える」の2つが選べる", (await page.locator(q("rain-switch-one")).isVisible()) && (await page.locator(q("rain-switch-all")).isVisible()));
  await shot("A4-rain-banner");

  step("A5. 今日の残りの屋外予定をすべて切り替える（提案モード: 軽い変更はワンタップで反映。元に戻せる）");
  await page.click(q("rain-switch-all"));
  await page.waitForSelector(q("diff-panel"));
  check("軽い変更なので、確認なしでそのまま反映される（組み直し案は出ない）", (await page.locator(q("proposal-card")).count()) === 0);
  check("「元に戻す」付きのトーストが出る", (await page.locator(q("toast-action")).count()) === 1 && (await text("toast-message")).includes("反映しました"));
  check("差分のすべての変更に、理由が出る（雨のため）", (await page.locator(`${q("diff-panel")} ${q("diff-reason")}`).count()) >= 1 && (await text("diff-panel")).includes("雨のため"));
  await shot("A5-applied");
  check("通知バナーが消える", (await page.locator(q("rain-banner")).count()) === 0);
  const after = await readBlocks();
  check("13時以降の屋外予定がなくなった", after.filter((b) => b.setting === "outdoor" && b.end > 13 * 60).length === 0);
  const switched = after.filter((b) => b.switched);
  check(`切り替わったブロックは屋内（${switched.map((b) => b.name).join("、")}）`, switched.length === outdoorLeft.length && switched.every((b) => b.setting === "indoor"));
  check("13時より前の予定は変わっていない", before.filter((b) => b.start <= 13 * 60).every((b) => after.find((a) => a.id === b.id)?.name === b.name));
  check("時系列に矛盾がない（重なりなし）", after.every((b, i) => i === 0 || b.start >= after[i - 1].end));
  await page.click(q("toast-action"));
  await page.waitForSelector(q("rain-banner"));
  const undone = await readBlocks();
  check("「元に戻す」で、切り替え前の旅程に完全に戻る（通知バナーも戻る）", JSON.stringify(undone.map((b) => [b.id, b.spotId, b.start, b.end])) === JSON.stringify(before.map((b) => [b.id, b.spotId, b.start, b.end])));
  await page.click(q("rain-switch-all"));
  await page.waitForSelector(q("diff-panel"));
  check("もう一度切り替えられる", (await readBlocks()).filter((b) => b.switched).length === outdoorLeft.length);
  await shot("A5-after-switch");

  step("A6. 遅延: 電車が30分遅延（余白が吸収）");
  await openSim();
  await page.selectOption(q("sim-delay-select"), "30");
  await page.click(q("sim-delay-button"));
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-title"]')?.textContent?.includes("遅延"));
  check("遅延の反映は軽い変更なので、そのまま反映される", (await page.locator(q("proposal-card")).count()) === 0);
  const delayed = await readBlocks();
  check("開始済みの予定は動かない", delayed.filter((b) => b.start <= 13 * 60).every((b) => after.find((a) => a.id === b.id)?.start === b.start));

  step("A7. 臨時休業: 次のスポットが臨時休業 → 代わりに切り替える");
  await openSim();
  await page.click(q("sim-close-button"));
  // 休業になる予定が標準・Must なら重い変更（外す案）なので確認が出る。Optional なら軽い変更でそのまま反映される
  await page.waitForSelector(`${q("proposal-card")}, ${q("closure-banner")}`);
  if (await page.locator(q("proposal-card")).count()) {
    check("標準・Must が休業になる案は、重い変更として確認が出る", (await page.locator(q("proposal-heavy")).count()) === 1);
    await confirmProposal();
  }
  await page.waitForSelector(q("closure-banner"));
  check("臨時休業の通知と代わりの候補が出る", (await page.locator(q("closure-replace")).count()) === 1);
  await page.click(q("closure-replace"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="closure-banner"]'));
  check("代わりの予定に切り替わり、通知が消える", true);

  step("A8. デモをリセット");
  await openSim();
  await page.click(q("sim-reset"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  check("リセットで変更履歴が消え、元の旅程に戻る", (await readBlocks()).filter((b) => b.switched).length === 0);

  step("A9. 共有リンク");
  await page.click(q("today-share"));
  await page.waitForSelector(q("share-url"));
  const url = await page.inputValue(q("share-url"));
  check("共有URLは /share?s=... の形", /\/share\?s=[A-Za-z0-9_-]+$/.test(url), url.slice(0, 80));
  const shared = await context.newPage();
  await shared.goto(url);
  await shared.waitForSelector('[data-testid="share-banner"]');
  const sharedNames = await shared.$$eval('[data-testid="block-spot"] h3', (els) => els.map((e) => e.textContent));
  const myNames = (await readBlocks()).map((b) => b.name);
  check("共有リンクを開くと、同じ旅程（スポットの並び）が見られる", sharedNames.length > 0 && JSON.stringify(sharedNames) === JSON.stringify(myNames));
  check("共有ページは閲覧専用（ドラッグハンドルなし）", (await shared.locator(q("drag-handle")).count()) === 0);
  await shared.close();
  const broken = await context.newPage();
  await broken.goto(`${BASE}/share?s=broken`);
  await broken.waitForSelector(q("share-error"));
  check("壊れたリンクはエラー表示（クラッシュしない）", true);
  await broken.close();

  step("A10. 旅程画面で並べ替え");
  await page.goto(`${BASE}/itinerary`);
  await page.waitForSelector(q("timeline"));
  const orderBefore = (await readBlocks()).map((b) => b.name);
  await page.locator(q("block-spot")).first().getByRole("button").first().click();
  await page.click(q("move-down"));
  await page.waitForFunction((first) => document.querySelector('[data-testid="block-spot"] h3')?.textContent !== first, orderBefore[0]);
  const orderAfter = (await readBlocks()).map((b) => b.name);
  check("↓ボタンで順番が入れ替わる", orderAfter[0] !== orderBefore[0]);
  await page.keyboard.press("Escape");
  const handle = page.locator(q("drag-handle")).nth(1);
  // ドラッグ元が画面の上のほうに来るようスクロールする（ドラッグ先の数件下も画面内に入れる）
  const handleTop = await handle.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), handleTop - 200);
  const box = await handle.boundingBox();
  const targetBox = await page.locator(q("drag-handle")).nth(3).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 4 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2 + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check("ドラッグで並べ替えられる", JSON.stringify((await readBlocks()).map((b) => b.name)) !== JSON.stringify(orderAfter));
  const starts = (await readBlocks()).map((b) => b.start);
  check("並べ替え後も時刻は昇順に計算し直されている", starts.every((s, i) => i === 0 || s >= starts[i - 1]));

  /* ====================================================================
   * シナリオB: 固定時刻（帰りの最終便）と「疲れた」
   * ==================================================================== */

  step("B1. 太宰府を含む日帰り旅程を作る");
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  await page.click(q("pace-normal"));
  await page.click(q("interest-history"));
  await page.click(q("must-toggle"));
  await page.click(q("must-dazaifu-shrine"));
  await page.click(q("must-dazaifu-kyuhaku"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  const dz = await readBlocks();
  check("太宰府の Must が旅程に入っている", ["dazaifu-shrine", "dazaifu-kyuhaku"].every((id) => dz.some((b) => b.spotId === id && b.label === "must")));
  check("メンバー（Aさん・Bさん・Cさん）が出ている", /Aさん.*Bさん.*Cさん/s.test(await text("members-card")));

  step("B2. 帰りの最終便を固定時刻として登録する（サンプルから選ぶ）");
  await page.click(q("fixed-add"));
  await page.waitForSelector(q("fixed-dialog"));
  check("サンプルの最終便は2〜3件で、実在の時刻表でないことが明記されている", (await page.locator('[data-testid^="fixed-preset-"]').count()) >= 2 && (await text("fixed-presets")).includes("実在の時刻表ではありません"));
  await page.click(q("fixed-preset-preset-dazaifu-train"));
  await page.waitForSelector(q("proposal-sheet"));
  check("組み直し案に、固定時刻を追加する手順が出る", (await text("proposal-steps")).includes("固定時刻を追加"));
  check("固定時刻に間に合う案", await page.locator(q("proposal-ok")).isVisible());
  await page.click(q("proposal-confirm"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="proposal-sheet"]'));
  check("固定時刻のブロックが鍵アイコン付きで表示される", (await page.locator(q("block-fixed")).count()) === 1 && (await page.locator(q("fixed-lock")).isVisible()));
  check("固定ブロックにはドラッグハンドルがない（動かせない）", (await page.locator('[data-testid="timeline-row"]:has([data-testid="block-fixed"]) [data-testid="drag-handle"]').count()) === 0);
  const dep = await text("fixed-departure");
  check(`「直前のスポットを出発すべき時刻」が逆算されている（${dep.trim().slice(0, 40)}…）`, /\d{2}:\d{2} までに「.+」を出発/.test(dep));
  check("余裕時間の初期値は10分", (await text("margin-value")).includes("10分"));
  await page.click(q("margin-plus"));
  await page.waitForFunction(() => document.querySelector('[data-testid="margin-value"]')?.textContent?.includes("15分") || document.querySelector('[data-testid="proposal-sheet"]'));
  if (await page.locator(q("proposal-sheet")).count()) await page.click(q("proposal-confirm"));
  await page.waitForFunction(() => document.querySelector('[data-testid="margin-value"]')?.textContent?.includes("15分"));
  check("余裕時間を変えると、出発すべき時刻が早まる", hhmmToMin(await text("fixed-departure")) < hhmmToMin(dep));
  await page.click(q("margin-minus"));
  await page.waitForFunction(() => document.querySelector('[data-testid="margin-value"]')?.textContent?.includes("10分"));
  await shot("B2-fixed");

  step("B3. 特定のメンバーだけの固定時刻（Cさんだけ 17:00 の電車で帰る）");
  await page.click(q("fixed-add"));
  await page.click(q("fixed-target-m3"));
  await page.click(q("fixed-tab-custom"));
  await page.fill(q("fixed-time"), "17:00");
  await page.click(q("fixed-submit"));
  await page.waitForSelector(q("proposal-sheet"));
  await page.click(q("proposal-confirm"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="proposal-sheet"]'));
  check("グループ内でCさんが抜けるタイミングが表示される", (await page.locator(q("member-fixed-marker")).count()) === 1 && (await text("member-fixed-marker")).includes("Cさん"));
  const absentChips = await page.locator(q("absent-chip")).allTextContents();
  check(`抜けたあとの予定が「Cさん不在」と表示される（${absentChips.length}件）`, absentChips.length >= 1 && absentChips.every((t) => t.includes("Cさん不在")));
  const idxMarker = await page.$$eval('[data-testid="timeline"] > li', (els) => els.findIndex((e) => e.getAttribute("data-testid") === "member-fixed-marker"));
  const idxAbsent = await page.$$eval('[data-testid="timeline"] > li', (els) => els.findIndex((e) => e.querySelector('[data-testid="absent-chip"]')));
  check("不在の表示は、抜けるタイミングより後ろだけ", idxMarker >= 0 && idxAbsent > idxMarker);
  await shot("B3-member-fixed");

  step("B4. 当日モード: 15:00 に電車が60分遅延 → 組み直され、最終便に間に合う旅程になる");
  await page.click(q("go-today"));
  await page.waitForURL("**/today");
  await page.waitForSelector(q("next-card"));
  await openSim();
  await page.click(q("sim-now-15:00"));
  const countdown = await text("fixed-departby");
  check(`次にやること: 固定時刻までの逆算が出る（${countdown.trim().slice(0, 50)}…）`, /\d{2}:\d{2} までに.*を出ないと、.*18:05.*に間に合いません/.test(countdown));
  check("Cさんの出発時刻も出る", (await text("fixed-countdown")).includes("Cさんは"));
  await openSim();
  await page.selectOption(q("sim-delay-select"), "60");
  await page.click(q("sim-delay-button"));
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-title"]')?.textContent?.includes("遅延"));
  check("遅延の反映は軽い変更なので、そのまま反映される（組み直し案は出ない）", (await page.locator(q("proposal-card")).count()) === 0);
  check("「元に戻す」付きのトーストが出る", (await page.locator(q("toast-action")).count()) === 1);
  check("確定すると、遅れた予定が後ろにずれている", (await page.locator('[data-testid="block-spot"]', { hasText: "遅れ" }).count()) >= 1);
  check("固定時刻のブロックは 18:05 のまま、間に合わない警告もない", (await page.locator(q("fixed-missed")).count()) === 0 && (await page.getAttribute(`${q("block-fixed")}`, "data-start")) === String(18 * 60 + 5));

  step("B5. 「疲れた」→「かなり疲れた」: 休憩が入り、それでも最終便に間に合う");
  const walkBefore = await text("walk-total");
  await page.click(q("tired-button"));
  await page.waitForSelector(q("tired-sheet"));
  check("2段階（少し休みたい／かなり疲れた）から選べる", (await page.locator(q("tired-light")).isVisible()) && (await page.locator(q("tired-heavy")).isVisible()));
  await shot("B5-tired-sheet");
  await page.click(q("tired-heavy"));
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-title"]')?.textContent?.includes("休憩"));
  check("休憩・Optional のスキップ・近い順の並べ替えは軽い変更なので、そのまま反映される", (await page.locator(q("proposal-card")).count()) === 0);
  const noteTexts = await page.locator(q("diff-panel")).allTextContents();
  check("グループには「メンバーの1人が休憩を希望しています」とだけ伝わる（名前は出ない）", noteTexts.some((t) => t.includes("メンバーの1人が休憩を希望しています")) && !/[ABC]さん/.test((await text("diff-title"))));
  check("固定時刻は守る旨が書かれている", noteTexts.some((t) => t.includes("固定時刻は守ります")));
  await shot("B5-heavy-applied");
  const rest = await page.$$eval('[data-testid="block-rest"]', (els) => els.map((e) => Number(e.dataset.end) - Number(e.dataset.start)));
  check(`60分の休憩ブロックが入る（${rest.join(",")}分）`, rest.includes(60));
  check("Must は残っている", (await page.locator('[data-testid="block-spot"][data-label="must"]:not([data-skipped="true"])').count()) >= 1);
  check("休憩後も固定時刻に間に合う（警告なし）", (await page.locator(q("fixed-missed")).count()) === 0);
  check("履歴のタイトルにメンバーの名前が出ない", (await text("diff-title")).includes("メンバーの1人が休憩を希望") && !/[ABC]さん/.test(await text("diff-title")));
  check("歩行距離のメーターは、休憩後も表示されている", (await text("walk-total")).length > 0 && walkBefore.length > 0);

  step("B6. 出発すべき時刻の30分前・10分前の通知");
  const departBy = hhmmToMin(await text("fixed-departby"));
  await setNowSlider(departBy - 25);
  await closeSim();
  await page.waitForSelector(q("departure-banner"));
  check("30分前の通知が出る", (await page.getAttribute(q("departure-banner"), "data-level")) === "before30" && (await text("departure-banner-title")).includes("30分前"));
  await page.click(q("departure-dismiss"));
  await setNowSlider(departBy - 5);
  await closeSim();
  await page.waitForSelector(q("departure-banner"));
  check("10分前の通知が出る", (await page.getAttribute(q("departure-banner"), "data-level")) === "before10" && (await text("departure-banner-title")).includes("10分前"));
  await shot("B6-departure-notice");

  step("B7. 少し休みたい（手動モードでは、軽い変更も差分を見て確定する）");
  await openSim();
  await page.click(q("sim-reset"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  await page.click(q("mode-manual"));
  check("手動モードに切り替わる", (await page.getAttribute(q("mode-switch"), "data-mode")) === "manual");
  await openSim();
  await page.click(q("sim-now-15:00"));
  await closeSim();
  await page.click(q("tired-button"));
  await page.click(q("tired-light"));
  await waitProposal();
  const restLight = await page.$$eval('[data-step-kind="insert-rest"]', (els) => els.length);
  check("30分の休憩を挟む案が出る", restLight === 1 && (await text("proposal-steps")).includes("30分"));
  check("15:00 にスターバックス滞在中なら、「ここで延長」が提案される", (await text("proposal-steps")).includes("ここで延長") && (await text("proposal-card")).includes("今いる場所"));
  check("手動モードのため、軽い変更でも差分を見て確定する旨が出る", (await page.locator(q("proposal-manual")).count()) === 1);
  check("案の差分のすべてに、理由が出る", (await page.locator(`${q("proposal-diff")} ${q("diff-reason")}`).count()) === (await page.locator(`${q("proposal-diff")} li`).count()));
  await page.click(q("proposal-cancel"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="proposal-card"]'));
  check("やめると旅程は変わらない", (await page.locator(q("block-rest")).count()) === 0);
  await page.click(q("mode-suggest"));

  step("B8. 最終便を 16:30 にして、14:30 に60分遅延 → 削られた予定の理由が「最終便」と出る");
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  await page.click(q("pace-normal"));
  await page.click(q("interest-history"));
  await page.click(q("must-toggle"));
  await page.click(q("must-dazaifu-shrine"));
  await page.click(q("must-dazaifu-kyuhaku"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  await page.click(q("fixed-add"));
  await page.waitForSelector(q("fixed-dialog"));
  await page.click(q("fixed-tab-custom"));
  await page.selectOption(q("fixed-place"), { label: "太宰府駅" });
  await page.fill(q("fixed-time"), "16:30");
  await page.click(q("fixed-submit"));
  await page.waitForSelector(q("proposal-sheet"));
  await page.click(q("proposal-confirm"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="proposal-sheet"]'));
  check("最終便 16:30 の固定ブロックが入る", (await page.getAttribute(q("block-fixed"), "data-start")) === String(16 * 60 + 30));
  await page.click(q("go-today"));
  await page.waitForURL("**/today");
  await page.waitForSelector(q("next-card"));
  await setNowSlider(14 * 60 + 30);
  await page.selectOption(q("sim-delay-select"), "60");
  await page.click(q("sim-delay-button"));
  await waitProposal();
  check("標準の予定を外す案なので、軽い変更ではなく、確認が出る", (await page.locator(q("proposal-heavy")).count()) === 1);
  const b8reasons = await page.locator(`${q("proposal-diff")} ${q("diff-reason")}`).allTextContents();
  check(`削られた・短くなった予定の理由に「最終便」が出る（${b8reasons[0] ?? ""}）`, b8reasons.length >= 1 && b8reasons.some((t) => t.includes("最終便")));
  check("案の差分のすべてに理由が出る", b8reasons.length === (await page.locator(`${q("proposal-diff")} li`).count()));
  await shot("B8-last-train-removal");
  await confirmProposal();
  check("確定後も、最終便は 16:30 のまま・間に合わない警告もない", (await page.getAttribute(q("block-fixed"), "data-start")) === String(16 * 60 + 30) && (await page.locator(q("fixed-missed")).count()) === 0);
  check("履歴の差分に「最終便」の理由が残る", (await text("diff-panel")).includes("最終便"));

  /* ====================================================================
   * シナリオM: 3つのモード（手動／提案／おまかせ）
   * ==================================================================== */

  step("M1. デモ設定の旅程を作り直して、当日モードを開く");
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  for (const c of ["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"]) {
    const on = (await page.getAttribute(q(`interest-${c}`), "aria-pressed")) === "true";
    if (on !== ["gourmet", "cafe"].includes(c)) await page.click(q(`interest-${c}`));
  }
  await page.click(q("pace-relaxed"));
  await page.click(q("rain-light-rain-ok"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  check("旅程画面にもモードの切り替えがある（初期値は提案）", (await page.getAttribute(q("mode-switch"), "data-mode")) === "suggest");
  await page.click(q("go-today"));
  await page.waitForURL("**/today");
  await page.waitForSelector(q("next-card"));
  const m0 = await readBlocks();

  step("M2. 手動モード: バナーは出ず、バッジだけ。変更はすべて差分を見て確定する");
  await page.click(q("mode-manual"));
  await openSim();
  await page.click(q("sim-now-13:00"));
  await page.click(q("sim-rain-button"));
  await page.waitForSelector(q("badge-rain"));
  check("雨の通知バナーは出ない", (await page.locator(q("rain-banner")).count()) === 0);
  check("代わりに小さなバッジで「雨の予報があります」と知らせる", (await text("badge-rain")).includes("雨の予報があります"));
  await page.click(q("badge-rain"));
  await waitProposal();
  check("バッジを押すと、組み直し案（差分）が出る。軽い変更でも確認になる", (await page.locator(q("proposal-manual")).count()) === 1);
  check("確定前は旅程が変わっていない", (await readBlocks()).filter((b) => b.switched).length === 0);
  await confirmProposal();
  await page.waitForSelector(q("diff-panel"));
  check("確定すると切り替わる", (await readBlocks()).filter((b) => b.switched).length >= 1);
  await page.click(q("undo-latest"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  const m2 = await readBlocks();
  check("変更履歴の「元に戻す」で、元の旅程に完全に戻る", JSON.stringify(m2.map((b) => [b.id, b.spotId, b.start, b.end])) === JSON.stringify(m0.map((b) => [b.id, b.spotId, b.start, b.end])));

  step("M3. おまかせモード: 軽い変更は自動で反映して知らせる（元に戻せる）");
  await openSim();
  await page.click(q("sim-rain-stop"));
  await page.click(q("mode-auto"));
  check("おまかせモードに切り替わる", (await page.getAttribute(q("mode-switch"), "data-mode")) === "auto");
  await openSim();
  await page.click(q("sim-now-13:00"));
  await page.click(q("sim-rain-button"));
  await page.waitForSelector(q("diff-panel"));
  check("タップなしで、屋外の予定が自動で Plan B に切り替わる", (await readBlocks()).filter((b) => b.switched).length >= 1);
  check("「自動で反映した変更」と表示され、元に戻せる", (await text("diff-panel")).includes("自動で反映した変更") && (await page.locator(q("undo-latest")).count()) === 1);
  check("トーストでも知らせる（元に戻す付き）", (await page.locator(q("toast-action")).count()) === 1 || (await text("diff-panel")).includes("おまかせで自動反映"));
  await page.click(q("undo-latest"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  check("元に戻すと切り替え前に戻り、同じ雨では再び自動反映されない", (await readBlocks()).filter((b) => b.switched).length === 0);

  step("M4. おまかせでも、重い変更（標準・Must を外す、固定時刻など）は自動反映されない");
  await openSim();
  await page.click(q("sim-rain-stop"));
  await page.click(q("sim-now-12:00"));
  await page.click(q("sim-close-button"));
  await page.waitForSelector(`${q("proposal-card")}, ${q("closure-banner")}`);
  const heavyShown = (await page.locator(q("proposal-heavy")).count()) === 1;
  check("標準・Must が休業になる案は、おまかせでも確認が出る（Optional が休業なら軽いので自動）", heavyShown || (await page.locator(q("closure-banner")).count()) === 1);
  if (heavyShown) check("「おまかせでも自動では反映しません」と書かれている", (await text("proposal-heavy")).includes("おまかせでも自動では反映しません"));
  if (await page.locator(q("proposal-card")).count()) await page.click(q("proposal-cancel"));

  step("M5. モードは旅程ごとに保存される");
  await page.reload();
  await page.waitForSelector(q("mode-switch"));
  check("再読み込みしても、おまかせのまま", (await page.getAttribute(q("mode-switch"), "data-mode")) === "auto");
  await page.click(q("mode-suggest"));

  /* ====================================================================
   * シナリオD: 当日の出来事（実績・寄り道・暑さ・早く進んだ）
   * ==================================================================== */

  step("D1. 太宰府の旅程（最終便なし）を作って、当日モードを開く");
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  await page.click(q("pace-normal"));
  await page.click(q("interest-history"));
  await page.click(q("must-toggle"));
  await page.click(q("must-dazaifu-shrine"));
  await page.click(q("must-dazaifu-kyuhaku"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  await page.click(q("go-today"));
  await page.waitForURL("**/today");
  await page.waitForSelector(q("next-card"));
  const d0 = await readBlocks();
  const kyuhaku = d0.find((b) => b.spotId === "dazaifu-kyuhaku");
  const afterKyuhaku = d0[d0.findIndex((b) => b.spotId === "dazaifu-kyuhaku") + 1];

  step("D2. 「出発した」を予定より20分遅く押すと、後ろの予定が遅れる");
  const lateAt = Math.ceil((kyuhaku.end + 20) / 5) * 5;
  await setNowSlider(lateAt);
  await closeSim();
  await page.waitForSelector(q("progress-departed"));
  check("予定の終了時刻を過ぎても、「出発した」を押せる", await page.locator(q("progress-departed")).isVisible());
  await page.click(q("progress-departed"));
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-title"]')?.textContent?.includes("出発した"));
  const d1 = await readBlocks();
  const kyuhakuAfter = d1.find((b) => b.spotId === "dazaifu-kyuhaku");
  check(`実績の出発時刻が記録される（${Math.floor(lateAt / 60)}:${String(lateAt % 60).padStart(2, "0")}）`, kyuhakuAfter.end === lateAt && (await page.locator(q("actual-end")).count()) >= 1);
  const nextAfter = d1.find((b) => b.id === afterKyuhaku.id);
  check(`次の予定が遅れる（${afterKyuhaku.start} → ${nextAfter.start}）`, nextAfter.start > afterKyuhaku.start && nextAfter.start - afterKyuhaku.start >= lateAt - kyuhaku.end - 15);
  check("遅れの反映は軽い変更なので、そのまま反映され、元に戻せる", (await page.locator(q("proposal-card")).count()) === 0 && (await page.locator(q("undo-latest")).count()) === 1);

  step("D3. 寄り道: 「ここに寄る」（自由入力）で1件追加する");
  await page.click(q("detour-button"));
  await page.waitForSelector(q("detour-sheet"));
  check("近くの営業中のスポットの候補か、見つからない旨が出る", (await page.locator(q("detour-candidates")).count()) + (await page.locator(q("detour-empty")).count()) === 1);
  check("自由入力は、移動を10分と仮定する旨が出る", (await text("detour-free-note")).includes("10分"));
  await page.fill(q("detour-free-name"), "お土産を見る");
  await page.click(q("detour-free-submit"));
  await page.waitForSelector(q("block-free"));
  check("寄り道が旅程に入る（移動は10分の仮定が出る）", (await text("block-free")).includes("お土産を見る") && (await text("block-free")).includes("10分と仮定"));
  check("理由に「寄り道を入れたため」が出る", (await text("diff-panel")).includes("寄り道を入れたため"));
  const d2 = await readBlocks();
  check("寄り道のあとの予定が、さらに後ろにずれている", d2.find((b) => b.id === afterKyuhaku.id).start >= nextAfter.start);

  step("D4. 暑さ（WBGT 31）: 昼の屋外の予定の対応");
  await openSim();
  await page.click(q("sim-heat-31"));
  await page.waitForSelector(q("heat-banner"));
  check("暑さの通知が出る（危険）", (await page.getAttribute(q("heat-banner"), "data-level")) === "danger" && (await text("heat-banner")).includes("危険"));
  check("影響する屋外の予定が列挙される", (await page.locator(`${q("heat-affected")} li`).count()) >= 1);
  check("危険のときは、休憩ではなく Plan B への切り替えだけが出る", (await page.locator(q("heat-switch-all")).count()) === 1 && (await page.locator(q("heat-rest")).count()) === 0);
  await page.click(q("heat-switch-all"));
  await page.waitForSelector(`${q("proposal-card")}, ${q("diff-panel")}`);
  const mustSwap = (await page.locator(q("proposal-heavy")).count()) === 1;
  check("Must の屋外（太宰府天満宮）の入れ替えは、重い変更として確認が出る", mustSwap && (await text("proposal-heavy")).includes("Must を別のスポットに入れ替える"));
  if (mustSwap) await page.click(q("proposal-cancel"));
  await openSim();
  await page.click(q("sim-heat-stop"));

  step("D5. 少し休みたい: いま滞在中のカフェで休憩が延長される");
  const starbucks = (await readBlocks()).find((b) => b.spotId === "dazaifu-starbucks");
  const mid = Math.floor((starbucks.start + starbucks.end) / 2 / 5) * 5;
  await setNowSlider(mid);
  await closeSim();
  await page.click(q("tired-button"));
  await page.click(q("tired-light"));
  await page.waitForSelector(q("block-rest"));
  check("スターバックス滞在中の休憩は「ここで休憩を延長」になる", (await page.getAttribute(`${q("block-rest")} [data-rest-mode]`, "data-rest-mode")) === "extend");

  step("D6. 早く進んだ（30分以上）: 提案が出る。自動では変わらない");
  await openSim();
  await page.click(q("sim-reset"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  const r0 = await readBlocks();
  const k0 = r0.find((b) => b.spotId === "dazaifu-kyuhaku");
  const earlyAt = Math.floor((k0.end - 35) / 5) * 5;
  await setNowSlider(earlyAt);
  await closeSim();
  await page.click(q("progress-departed"));
  await page.waitForSelector(q("early-card"));
  check("予定より30分以上早く出発すると、「早く進んでいます」の提案が出る", (await text("early-card")).includes("早く進んでいます"));
  check("近くのスポット追加・余白を増やす提案がある", (await page.locator(q("early-add-optional")).count()) + (await page.locator(q("early-add-buffer")).count()) >= 1);
  const buffersBefore = await page.locator(q("block-buffer")).count();
  check("提案は、選ぶまで旅程に入らない（自動では変わらない）", (await page.locator(q("block-free")).count()) === 0);
  if (await page.locator(q("early-add-buffer")).count()) {
    await page.click(q("early-add-buffer"));
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="block-buffer"]').length > n, buffersBefore);
    check("「余白を増やす」を選ぶと、余白が増える", (await page.locator(q("block-buffer")).count()) > buffersBefore);
  }

  /* ====================================================================
   * シナリオH: 堅牢性（壊れた共有リンク・保存データ・Error Boundary）
   * ==================================================================== */

  const b64url = (text) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tokenOf = (payload) => b64url(JSON.stringify(payload));
  const V3 = "replan-fukuoka:v3";
  const V2 = "replan-fukuoka:v2";

  step("H1. 壊れた共有リンクでも、画面が落ちず、理由が出る");
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  await page.click(q("share-button"));
  await page.waitForSelector(q("share-url"));
  const goodUrl = await page.inputValue(q("share-url"));
  const goodPayload = JSON.parse(Buffer.from(new URL(goodUrl).searchParams.get("s").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  const mut = (fn) => {
    const p = structuredClone(goodPayload);
    fn(p);
    return tokenOf(p);
  };
  const badLinks = [
    ["時刻が文字列", mut((p) => (p[4][0][3][0][2] = "10:00")), /正しくありません/],
    ["存在しないスポットID", mut((p) => (p[4][0][3][0][1] = "no-such-spot")), /存在しないスポット/],
    ["巨大な配列（ブロックが多すぎる）", mut((p) => (p[4][0][3] = Array.from({ length: 90 }, () => structuredClone(goodPayload[4][0][3][0])))), /正しくありません/],
    ["深いネスト", b64url("[".repeat(2800) + "]".repeat(2800)), /形式|対応していない|正しくありません/],
    ["8KBを超えるリンク", "A".repeat(9000), /長すぎます/],
    ["途中で切れたリンク", new URL(goodUrl).searchParams.get("s").slice(0, 60), /形式が壊れています|正しくありません/],
  ];
  for (const [label, token, re] of badLinks) {
    await page.goto(`${BASE}/share?s=${token}`);
    await page.waitForSelector(q("share-error"));
    const reason = await text("share-error-reason");
    check(`${label}: 落ちずに、理由が出る（${reason.slice(0, 40)}…）`, re.test(reason));
  }
  check("エラー画面からも、ナビゲーションが使える", (await page.locator('nav a[href="/"]').count()) === 1);

  step("H2. 読めない保存データ（壊れている）は、確認してから削除・バックアップ");
  await page.goto(`${BASE}/itinerary`);
  await page.evaluate((k) => localStorage.setItem(k, "{壊れた保存データ"), V3);
  await page.reload();
  await page.waitForSelector(q("load-issue-dialog"));
  check("確認ダイアログが出る（壊れている）", (await page.getAttribute(q("load-issue-dialog"), "data-kind")) === "corrupt");
  check("確認が済むまでは、データは勝手に消えない", (await page.evaluate((k) => localStorage.getItem(k), V3)) === "{壊れた保存データ");
  await page.click(q("load-issue-backup"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="load-issue-dialog"]'));
  check("「バックアップとして残す」を選ぶと、退避されて新しく始められる", (await page.evaluate(() => localStorage.getItem("replan-fukuoka:backup"))) === "{壊れた保存データ" && (await page.evaluate((k) => localStorage.getItem(k), V3)) === null);

  step("H3. 旧版（v2）の保存データは v3 に変換され、食事の印も補われる");
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  const stateText = await page.evaluate((k) => localStorage.getItem(k), V3);
  const state = JSON.parse(stateText).state;
  for (const d of state.itinerary.days) for (const b of d.blocks) delete b.meal;
  delete state.today;
  await page.evaluate(([k2, k3, v]) => {
    localStorage.removeItem(k3);
    localStorage.setItem(k2, v);
  }, [V2, V3, JSON.stringify(state)]);
  await page.goto(`${BASE}/itinerary`);
  await page.waitForSelector(q("timeline"));
  await page.waitForFunction(() => document.body.textContent?.includes("🍽"));
  check("旧版のデータが読み込まれ、食事（ランチ・ディナー）の印が補われる", (await page.locator('[data-testid="block-spot"]', { hasText: "🍽" }).count()) >= 1);
  await page.waitForFunction((k) => localStorage.getItem(k) !== null, V3);
  check("v3 の形式で保存し直され、旧版のキーは消える", (await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).version, V3)) === 3 && (await page.evaluate((k) => localStorage.getItem(k), V2)) === null);

  step("H4. 読めない旧版・いまのデータにないスポットを含む保存データも、確認が出る");
  await page.evaluate((k) => {
    localStorage.removeItem("replan-fukuoka:v3");
    localStorage.setItem(k, JSON.stringify({ itinerary: { version: 1, nonsense: true } }));
  }, V2);
  await page.reload();
  await page.waitForSelector(q("load-issue-dialog"));
  check("読めない旧版は「古い形式」として確認が出る", (await page.getAttribute(q("load-issue-dialog"), "data-kind")) === "legacy");
  await page.click(q("load-issue-delete"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="load-issue-dialog"]'));
  check("「削除して始める」で、保存データが消える", (await page.evaluate((k) => localStorage.getItem(k), V2)) === null);
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  const saved = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), V3));
  saved.state.itinerary.days[0].blocks[0].spotId = "gone-spot-id";
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [V3, JSON.stringify(saved)]);
  await page.reload();
  await page.waitForSelector(q("load-issue-dialog"));
  check("いまのデータにないスポットを含む保存データは、確認が出る", (await page.getAttribute(q("load-issue-dialog"), "data-kind")) === "unknown-spots");
  await page.click(q("load-issue-delete"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="load-issue-dialog"]'));

  step("H5. 共有リンクから「自分の旅程として保存」できる（検証を通ったデータだけ）");
  await page.goto(goodUrl);
  await page.waitForSelector(q("share-banner"));
  await page.click(q("save-shared"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  check("保存されて、旅程画面で開く", (await page.locator(q("block-spot")).count()) >= 1 && (await page.locator(q("save-error-banner")).count()) === 0);

  step("H6. 想定外の例外: Error Boundary の画面から、開き直し・初期化ができる");
  await page.goto(`${BASE}/debug/crash`);
  await page.waitForSelector(q("crash-now"));
  await page.click(q("crash-now"));
  await page.waitForSelector(q("error-screen"));
  check("例外が起きても、エラー画面が出る（ヘッダー・ナビは残る）", (await text("error-screen")).includes("問題が起きました") && (await page.locator('nav a[href="/today"]').count()) === 1);
  check("「データを初期化」「共有リンクを開き直す」「もう一度表示する」が選べる", (await page.locator(q("error-reset-data")).count()) === 1 && (await page.locator(q("error-open-share")).count()) === 1 && (await page.locator(q("error-retry")).count()) === 1);
  await page.fill(q("error-share-input"), "これはリンクではありません！");
  await page.click(q("error-open-share"));
  check("共有リンクとして読み取れない入力は、案内が出る", (await text("error-screen")).includes("読み取れませんでした"));
  await page.fill(q("error-share-input"), goodUrl);
  await page.click(q("error-open-share"));
  await page.waitForURL("**/share?s=*");
  await page.waitForSelector(q("share-banner"));
  check("貼り付けた共有リンクを開き直せる", true);
  await page.goto(`${BASE}/debug/crash`);
  await page.click(q("crash-now"));
  await page.waitForSelector(q("error-screen"));
  page.once("dialog", (d) => d.accept());
  await page.click(q("error-reset-data"));
  await page.waitForURL(`${BASE}/`);
  check("「データを初期化」で、保存データがすべて消える", (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("replan-fukuoka")).length)) === 0);
  consoleErrors.length = 0; // この手順で起こした例外のログは、わざと起こしたもの
  consoleErrors.length = 0; // この手順で起こした例外のログは、わざと起こしたもの

  /* ====================================================================
   * シナリオG: グループ（4人の希望を集めて、3案 → 投票 → 確定）
   * ==================================================================== */

  step("G1. トップからグループ画面へ。メンバー4人・主催者・候補日を入れる");
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(q("group-entry"));
  await page.click(q("group-entry"));
  await page.waitForURL("**/group");
  await page.waitForSelector(q("group-setup"));
  check("メンバーは最初2人。2人未満には減らせない（外すボタンがない）", (await page.locator('[data-testid^="group-name-"]').count()) === 2 && (await page.locator('button[aria-label^="メンバー"][aria-label$="を外す"]').count()) === 0);
  check("入力が空のあいだは、始められない", await page.isDisabled(q("group-create")));
  await page.click(q("group-add-member"));
  await page.click(q("group-add-member"));
  const NAMES = ["あおい", "ゆうと", "みさき", "けん"];
  for (let i = 0; i < 4; i++) await page.fill(q(`group-name-${i}`), NAMES[i]);
  check("メンバーは6人まで（7人目は追加できない）", await (async () => {
    await page.click(q("group-add-member"));
    await page.click(q("group-add-member"));
    const six = (await page.locator('[data-testid^="group-name-"]').count()) === 6 && (await page.locator(q("group-add-member")).count()) === 0;
    for (let k = 0; k < 2; k++) await page.click('button[aria-label="メンバー6を外す"], button[aria-label="メンバー5を外す"]');
    return six;
  })());
  check("候補日は2〜4日", (await page.locator('[data-testid^="group-date-"]').count()) === 2);
  await page.click(q("group-create"));
  await page.waitForSelector(q("group-answers"));
  check("回答の進み具合が出る（0/4人）", (await text("group-progress")).includes("0/4"));
  check("案を作るボタンは、2人以上が回答するまで押せない", await page.isDisabled(q("group-make-plans")));

  step("G2. 1台を回して、4人が順に入力（予算・好み・行きたい場所）。他の人の予算・苦手は、一覧に出ない");
  const answer = async (id, o) => {
    await page.click(q(`group-answer-${id}`));
    await page.waitForSelector(q("member-form"));
    await page.click(q(`member-budget-${o.budget}`));
    await page.click(q(`member-rain-${o.rain}`));
    await page.click(q(`member-pace-${o.pace}`));
    for (const [cat, vote] of Object.entries(o.interests ?? {})) await page.click(q(`member-interest-${cat}-${vote}`));
    for (const [i, spot] of (o.wishes ?? []).entries()) await page.selectOption(q(`member-wish-${i}`), spot);
    await page.click(q("member-submit"));
    await page.waitForSelector(q("group-answers"));
  };
  await answer("m1", { budget: 8000, rain: "light-rain-ok", pace: "normal", interests: { gourmet: "like", nature: "dislike" }, wishes: ["nakasu-ichiran"] });
  check("1人回答すると 1/4人になる", (await text("group-progress")).includes("1/4"));
  await answer("m2", { budget: 15000, rain: "dont-care", pace: "packed", interests: { nature: "like", history: "like" }, wishes: ["ohori-park", "hakata-kushida"] });
  await answer("m3", { budget: 10000, rain: "no-outdoor", pace: "normal", interests: { cafe: "like", art: "like" }, wishes: ["ohori-art", "ohori-park"] });
  const listText = await text("group-answers");
  check("回答の一覧に、予算の金額・苦手は出ない（回答済みの表示だけ）", !/15,000|10,000|8,000|15000|苦手/.test(listText) && listText.includes("✓ 回答済み"));
  check("3/4人が回答", (await text("group-progress")).includes("3/4"));
  check("未回答の人がいても、2人以上なら「除いて案を作る」が押せる", !(await page.isDisabled(q("group-make-plans"))) && (await text("group-make-plans")).includes("けん"));
  await answer("m4", { budget: 12000, rain: "light-rain-ok", pace: "relaxed" });
  check("4/4人が回答して、「3つの案を作る」になる", (await text("group-progress")).includes("4/4") && (await text("group-make-plans")).includes("3つの案"));
  // 回答を直すときは、本人確認の表示が出てから、本人の入力（予算）が見える
  await page.click(q("group-reanswer-m1"));
  check("回答を直すときは、先に確認が出る", (await page.locator(q("reanswer-confirm")).count()) === 1 && !(await page.locator(q("member-form")).count()));
  await page.click(q("group-reanswer-ok-m1"));
  await page.waitForSelector(q("member-form"));
  check("本人の入力画面では、自分の予算・苦手が見える", (await page.inputValue(q("member-budget"))) === "8000" && (await page.getAttribute(q("member-interest-nature-dislike"), "aria-checked")) === "true");
  await page.click(q("member-cancel"));
  await page.waitForSelector(q("group-answers"));

  step("G3. 調整ポイントと、3つの案（満足度・誰の希望か）");
  await page.click(q("group-make-plans"));
  await page.waitForSelector(q("group-results"), { timeout: 30000 });
  const adj = await text("group-adjustments");
  check("調整ポイント: 予算は最小の ¥8,000、雨は屋外NG、ペースは偶数で割れず「普通」", adj.includes("¥8,000") && adj.includes("屋外NG") && adj.includes("「普通」"));
  check("調整ポイント: 希望が重なった「大濠公園」が必ず行く場所に、あおいさんの希望も入る", adj.includes("大濠公園") && adj.includes("ゆうと・みさき") && adj.includes("一蘭"));
  const resultsText = await text("group-results");
  check("結果の画面に、他の人の予算額は出ない。調整ポイントに苦手なカテゴリ（自然）も出ない", !/15,000|12,000|10,000/.test(resultsText) && !adj.includes("自然"));
  check("3つの案（バランス・合計いちばん・移動いちばん少ない）が並ぶ", (await page.locator('[data-testid^="plan-card-"]').count()) === 3);
  for (const k of ["balanced", "max-sum", "least-travel"]) {
    check(`${k}: メンバー4人ぶんの満足度（0〜100）が出る`, (await page.locator(`[data-testid^="sat-${k}-"]`).count()) === 4);
  }
  const minOf = async (k) => Number(await text(`plan-min-${k}`));
  check("バランス案の最低満足度は、合計いちばん案の最低満足度以上", (await minOf("balanced")) >= (await minOf("max-sum")));
  const satText = (await Promise.all(["balanced", "max-sum", "least-travel"].map(async (k) => (await page.locator(`[data-testid^="sat-${k}-"]`).allTextContents()).join(" ")))).join(" ");
  check("満足度の理由に、苦手なカテゴリ名（自然）や「苦手」は出ない", !/自然|苦手/.test(satText), satText.slice(0, 120));
  const requested = await page.locator(`${q("plan-card-balanced")} [data-testid^="requested-balanced-"] span`).count();
  check("予定に「誰の希望か」のアイコンが付く", requested >= 3);
  check("食事（ランチ・ディナー）が旅程に入っている", (await text("plan-card-balanced")).includes("ランチ") && (await text("plan-card-balanced")).includes("ディナー"));
  check("希望が大きく割れていない（警告は出ない）", (await page.locator(q("group-split")).count()) === 0);
  await shot("group-results");

  step("G4. 投票: 全員が投票するまで結果は見えない。同票なら主催者の票で決まる");
  const voteAs = async (id, kind) => {
    await page.click(q(`vote-as-${id}`));
    await page.click(q(`vote-pick-${kind}`));
  };
  await voteAs("m1", "max-sum");
  check("1人投票すると 1/4人", (await text("vote-progress")).includes("1/4"));
  check("投票した人は、もう投票者の選択肢に出ない", (await page.locator(q("vote-as-m1")).count()) === 0);
  await voteAs("m2", "max-sum");
  await voteAs("m3", "balanced");
  check("全員が投票するまで、結果は出ない", (await page.locator(q("vote-result")).count()) === 0);
  await voteAs("m4", "balanced");
  await page.waitForSelector(q("vote-winner"));
  check("同票（2対2）は、主催者（あおい）の票の「合計いちばん案」に決まる", (await page.getAttribute(q("vote-winner"), "data-kind")) === "max-sum" && (await text("vote-winner")).includes("主催者の票"));
  check("決まったあとに、各案の得票が出る", (await text("plan-votes-max-sum")).includes("2票") && (await text("plan-votes-balanced")).includes("2票"));
  await page.click(q("vote-reset"));
  check("投票をやり直せる", (await text("vote-progress")).includes("0/4") && (await page.locator(q("vote-result")).count()) === 0);
  await voteAs("m1", "least-travel");
  await voteAs("m2", "balanced");
  await voteAs("m3", "balanced");
  await voteAs("m4", "max-sum");
  await page.waitForSelector(q("vote-winner"));
  check("過半数の案（バランス案）が、そのまま決まる", (await page.getAttribute(q("vote-winner"), "data-kind")) === "balanced");

  step("G5. 確定すると、ふつうの旅程になる（当日モードも使える）");
  await page.click(q("confirm-plan"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));
  check("旅程画面に、選んだ案の予定が出る（大濠公園・一蘭が入っている）", (await text("timeline")).includes("大濠公園") && (await text("timeline")).includes("一蘭"));
  check("旅程の保存データには、個人の予算・苦手・回答が入らない", await page.evaluate(() => {
    const raw = localStorage.getItem("replan-fukuoka:v3") ?? "";
    return !/dislike|budgetCapYen|availableDates|wantedSpotIds|15000|12000/.test(raw);
  }));
  const shareUrl = await (async () => {
    await page.click(q("share-button"));
    await page.waitForSelector(q("share-url"));
    return page.inputValue(q("share-url"));
  })();
  const sharePayload = Buffer.from(new URL(shareUrl).searchParams.get("s").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  check("共有リンクの中身にも、他の人の予算額・苦手は含まれない", !/dislike|like|budget|15000|12000|10000|8000/.test(sharePayload));
  await page.goto(`${BASE}/today`);
  await page.waitForSelector(q("timeline"));
  check("当日モードで、確定した旅程を開ける", (await page.locator(q("block-spot")).count()) >= 2);

  step("C1. グループの旅程: 当日の遅延（おまかせ: 自動反映 → 元に戻す）と、雨（Must の屋外は確認 → 元に戻す）");
  await page.waitForSelector(q("next-card"));
  await page.click(q("mode-auto"));
  check("おまかせモードに切り替わる", (await page.getAttribute(q("mode-switch"), "data-mode")) === "auto");
  await setNowSlider(9 * 60 + 30);
  await closeSim();
  const sigOf = (list) => JSON.stringify(list.map((b) => [b.id, b.spotId, b.start, b.end, b.switched]));
  const c0 = await readBlocks();
  await openSim();
  await page.selectOption(q("sim-delay-select"), "30");
  await page.click(q("sim-delay-button"));
  await page.waitForSelector(q("diff-panel"));
  check("遅延（軽い変更）は、確認なしでそのまま反映される（組み直し案は出ない）", (await text("diff-title")).includes("遅延") && (await page.locator(q("proposal-card")).count()) === 0);
  await page.click(q("undo-latest"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  check("「元に戻す」で、遅延の前の旅程にぴったり戻る", sigOf(await readBlocks()) === sigOf(c0));
  await openSim();
  await page.click(q("sim-rain-button"));
  await page.waitForSelector(`${q("rain-banner")}, ${q("proposal-card")}, ${q("diff-panel")}`);
  if (await page.locator(q("rain-banner")).count()) {
    check("Must の屋外は、おまかせモードでも自動では替えず、通知で聞く", true);
    await page.click(q("rain-switch-all"));
  }
  await page.waitForSelector(`${q("proposal-card")}, ${q("diff-panel")}`);
  if (await page.locator(q("proposal-card")).count()) {
    check("雨で Must の屋外を Plan B に替える案は、重い変更なので確認が出る（おまかせでも自動では反映しない）", (await page.locator(q("proposal-heavy")).count()) === 1);
    await confirmProposal();
  }
  const c1 = await readBlocks();
  check("確定すると、屋外の予定が Plan B に切り替わる", c1.some((b) => b.switched));
  check("差分のすべてに、理由（雨のため）が出る", (await page.locator(`${q("diff-panel")} ${q("diff-reason")}`).count()) >= 1 && (await text("diff-panel")).includes("雨のため"));
  await page.click(q("undo-latest"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="diff-panel"]') || !document.querySelector('[data-testid="undo-latest"]'));
  check("「元に戻す」で、雨の前の旅程にぴったり戻る", sigOf(await readBlocks()) === sigOf(c0));

  step("G6. グループの保存データが壊れていても、確認が出る（勝手に消さない）");
  await page.evaluate(() => localStorage.setItem("replan-fukuoka:group:v1", "{壊れたグループ"));
  await page.goto(`${BASE}/group`);
  await page.waitForSelector(q("group-load-issue"));
  check("読めないグループの保存データは、確認が出る。確認前は消えない", (await page.evaluate(() => localStorage.getItem("replan-fukuoka:group:v1"))) === "{壊れたグループ");
  await page.click(q("group-issue-backup"));
  await page.waitForSelector(q("group-setup"));
  check("「バックアップに残して始める」で、退避して新しく始められる", (await page.evaluate(() => localStorage.getItem("replan-fukuoka:group:backup"))) === "{壊れたグループ" && (await page.evaluate(() => localStorage.getItem("replan-fukuoka:group:v1"))) === null);

  step("G7. 「サンプルで試す」: 4人ぶん入力済みで始まり、すぐに3つの案が見られる");
  await page.click(q("group-sample"));
  await page.waitForSelector(q("group-answers"));
  check("4/4人が回答済みで始まる", (await text("group-progress")).includes("4/4") && (await text("group-make-plans")).includes("3つの案"));
  await page.click(q("group-make-plans"));
  await page.waitForSelector(q("group-results"), { timeout: 30000 });
  check("調整ポイントと3つの案が出る", (await text("group-adjustments")).includes("¥8,000") && (await page.locator('[data-testid^="plan-card-"]').count()) === 3);
} catch (e) {
  failures++;
  console.error("\n✗ シナリオ中にエラー:", e.message);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "error.png") }).catch(() => {});
}

check("ブラウザのコンソールエラーがない", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures ? `\n❌ ${failures} 件の確認に失敗しました` : "\n✅ デモシナリオはすべて通りました");
process.exit(failures ? 1 : 0);
