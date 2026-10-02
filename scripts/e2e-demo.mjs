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
  check("降水確率の初期値は80%", (await text("sim-rain-prob-label")).includes("80%"));
  await page.click(q("sim-rain-button"));
  await page.waitForSelector(q("rain-banner"));
  check("「Plan Bに切り替えますか？」の通知が出る", (await text("rain-banner")).includes("Plan Bに切り替えますか"));
  check(`影響する屋外予定が列挙される`, (await page.locator(`${q("rain-affected")} li`).count()) === outdoorLeft.length);
  check("「1つだけ切り替える」「残りすべて切り替える」の2つが選べる", (await page.locator(q("rain-switch-one")).isVisible()) && (await page.locator(q("rain-switch-all")).isVisible()));
  await shot("A4-rain-banner");

  step("A5. 今日の残りの屋外予定をすべて切り替える（差分を見て、確定する）");
  await page.click(q("rain-switch-all"));
  await waitProposal();
  check("組み直し案が出る（まだ反映されていない）", (await text("proposal-card")).includes("まだ反映されていません"));
  check("案の差分に切替前後が出る", (await page.locator(`${q("proposal-diff")} ${q("diff-replaced")}`).count()) === outdoorLeft.length);
  check("確定前は旅程が変わっていない", (await readBlocks()).filter((b) => b.switched).length === 0);
  await shot("A5-proposal");
  await confirmProposal();
  await page.waitForSelector(q("diff-panel"));
  check("通知バナーが消える", (await page.locator(q("rain-banner")).count()) === 0);
  const after = await readBlocks();
  check("13時以降の屋外予定がなくなった", after.filter((b) => b.setting === "outdoor" && b.end > 13 * 60).length === 0);
  const switched = after.filter((b) => b.switched);
  check(`切り替わったブロックは屋内（${switched.map((b) => b.name).join("、")}）`, switched.length === outdoorLeft.length && switched.every((b) => b.setting === "indoor"));
  check("13時より前の予定は変わっていない", before.filter((b) => b.start <= 13 * 60).every((b) => after.find((a) => a.id === b.id)?.name === b.name));
  check("時系列に矛盾がない（重なりなし）", after.every((b, i) => i === 0 || b.start >= after[i - 1].end));
  await shot("A5-after-switch");

  step("A6. 遅延: 電車が30分遅延（余白が吸収）");
  await openSim();
  await page.selectOption(q("sim-delay-select"), "30");
  await page.click(q("sim-delay-button"));
  await waitProposal();
  check("組み直し案に「電車が30分遅延」が出る", (await text("proposal-title")).includes("電車が30分遅延"));
  await confirmProposal();
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-title"]')?.textContent?.includes("遅延"));
  const delayed = await readBlocks();
  check("開始済みの予定は動かない", delayed.filter((b) => b.start <= 13 * 60).every((b) => after.find((a) => a.id === b.id)?.start === b.start));

  step("A7. 臨時休業: 次のスポットが臨時休業 → 代わりに切り替える");
  await openSim();
  await page.click(q("sim-close-button"));
  await waitProposal();
  await confirmProposal();
  await page.waitForSelector(q("closure-banner"));
  check("臨時休業の通知と代わりの候補が出る", (await page.locator(q("closure-replace")).count()) === 1);
  await page.click(q("closure-replace"));
  await waitProposal();
  await confirmProposal();
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
  await waitProposal();
  check("遅延を反映する手順が提案に出る", (await page.locator('[data-step-kind="delay"]').count()) >= 1);
  check("固定時刻に間に合う案", await page.locator(q("proposal-ok")).isVisible());
  check("確定するまで旅程は変わらない", (await page.locator('[data-skipped="true"]').count()) === 0);
  await shot("B4-delay-proposal");
  await confirmProposal();
  check("確定すると、遅れた予定が後ろにずれている", (await page.locator('[data-testid="block-spot"]', { hasText: "遅れ" }).count()) >= 1);
  check("固定時刻のブロックは 18:05 のまま、間に合わない警告もない", (await page.locator(q("fixed-missed")).count()) === 0 && (await page.getAttribute(`${q("block-fixed")}`, "data-start")) === String(18 * 60 + 5));

  step("B5. 「疲れた」→「かなり疲れた」: 休憩が入り、歩行距離が減り、それでも最終便に間に合う");
  await page.click(q("tired-button"));
  await page.waitForSelector(q("tired-sheet"));
  check("2段階（少し休みたい／かなり疲れた）から選べる", (await page.locator(q("tired-light")).isVisible()) && (await page.locator(q("tired-heavy")).isVisible()));
  await shot("B5-tired-sheet");
  await page.click(q("tired-heavy"));
  await waitProposal();
  check("固定時刻に間に合う案", await page.locator(q("proposal-ok")).isVisible());
  const stepKinds = await page.$$eval("[data-step-kind]", (els) => els.map((e) => e.getAttribute("data-step-kind")));
  check("休憩（60分）を挟む手順が入っている", stepKinds.includes("insert-rest"));
  const walkText = await text("proposal-walking");
  const km = [...walkText.matchAll(/(\d+\.\d)km/g)].map((m) => Number(m[1]));
  check(`残りの推定歩行距離が増えない（${km[0]}km → ${km[1]}km）`, km.length >= 2 && km[1] <= km[0]);
  const noteTexts = await page.locator(q("proposal-note")).allTextContents();
  check("グループには「メンバーの1人が休憩を希望しています」とだけ伝わる（名前は出ない）", noteTexts.some((t) => t.includes("メンバーの1人が休憩を希望しています")) && !/[ABC]さん/.test((await text("proposal-card")).replace(/Cさん[^。]*電車[^。]*/g, "")));
  check("Must と固定時刻は守る旨が書かれている", noteTexts.some((t) => t.includes("固定時刻は守ります")));
  await shot("B5-heavy-proposal");
  await confirmProposal();
  const rest = await page.$$eval('[data-testid="block-rest"]', (els) => els.map((e) => Number(e.dataset.end) - Number(e.dataset.start)));
  check(`確定すると、60分の休憩ブロックが入る（${rest.join(",")}分）`, rest.includes(60));
  check("Must は残っている", (await page.locator('[data-testid="block-spot"][data-label="must"]:not([data-skipped="true"])').count()) >= 1);
  check("確定後も固定時刻に間に合う（警告なし）", (await page.locator(q("fixed-missed")).count()) === 0);
  check("履歴のタイトルにメンバーの名前が出ない", (await text("diff-title")).includes("メンバーの1人が休憩を希望") && !/[ABC]さん/.test(await text("diff-title")));

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

  step("B7. 少し休みたい（リセット後）");
  await openSim();
  await page.click(q("sim-reset"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  await openSim();
  await page.click(q("sim-now-15:00"));
  await closeSim();
  await page.click(q("tired-button"));
  await page.click(q("tired-light"));
  await waitProposal();
  const restLight = await page.$$eval('[data-step-kind="insert-rest"]', (els) => els.length);
  check("30分の休憩を挟む案が出る", restLight === 1 && (await text("proposal-steps")).includes("30分"));
  check("15:00 にスターバックス滞在中なら、「ここで延長」が提案される", (await text("proposal-steps")).includes("ここで延長") && (await text("proposal-card")).includes("今いる場所"));
  await page.click(q("proposal-cancel"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="proposal-card"]'));
  check("やめると旅程は変わらない", (await page.locator(q("block-rest")).count()) === 0);
} catch (e) {
  failures++;
  console.error("\n✗ シナリオ中にエラー:", e.message);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "error.png") }).catch(() => {});
}

check("ブラウザのコンソールエラーがない", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures ? `\n❌ ${failures} 件の確認に失敗しました` : "\n✅ デモシナリオはすべて通りました");
process.exit(failures ? 1 : 0);
