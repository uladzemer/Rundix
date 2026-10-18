const assert = require("node:assert/strict"),
  path = require("node:path");
module.exports = async ({ page, suffix = "" }) => {
  await page.bringToFront();
  const previous = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.fixture)),
  );
  await page.evaluate(() => {
    window.fixture.busy = false;
    window.fixture.followUps = [];
    window.fixture.preflight = {
      enabled: true,
      id: "synthetic-task",
      revision: 4,
      phase: "ready",
      spec: {
        goal: "Добавить поиск по заметкам",
        scope: ["Поиск по заголовку и тексту"],
        nonGoals: ["Синхронизация"],
        constraints: ["Без новых зависимостей"],
        assumptions: ["Поиск без учёта регистра"],
        criteria: [
          "Запрос находит заметку по части заголовка; проверить в браузере",
          "Пустой запрос показывает все заметки",
        ],
        steps: ["Добавить фильтр", "Проверить найденные и пустые результаты"],
        openQuestions: [],
      },
    };
    window.update();
  });
  await page.waitForSelector(".task-preflight:not([hidden])");
  assert.equal(
    await page.$eval(".task-preflight details", (n) => n.open),
    true,
  );
  assert.equal(
    await page.$eval(".task-preflight > button", (n) => n.disabled),
    false,
  );
  await page.click(".task-preflight > button");
  assert.ok(
    await page.evaluate(() =>
      window.calls.some(
        (m) =>
          m.action === "approveTask" &&
          m.id === "synthetic-task" &&
          m.revision === 4,
      ),
    ),
  );
  await page.evaluate(() => {
    window.fixture.busy = true;
    window.update();
  });
  assert.equal(
    await page.$eval(".task-preflight > button", (n) => n.disabled),
    true,
  );
  await page.evaluate(() => {
    window.fixture.busy = false;
    window.fixture.preflight.phase = "clarifying";
    window.fixture.preflight.skipped = true;
    window.update();
  });
  assert.equal(
    await page.$eval(".task-preflight > button", (n) => n.hidden),
    true,
  );
  await page.evaluate(() => {
    window.fixture.preflight.phase = "ready";
    window.fixture.preflight.skipped = false;
    window.update();
  });
  await page.setViewport({ width: 340, height: 850 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(
      __dirname,
      "../.verification/preflight-narrow" + suffix + ".png",
    ),
  });
  await page.setViewport({ width: 1100, height: 900 });
  await page.screenshot({
    path: path.join(
      __dirname,
      "../.verification/preflight-panel" + suffix + ".png",
    ),
  });
  await page.evaluate((previous) => {
    window.fixture = { ...previous, preflight: previous.preflight || null };
    window.update();
  }, previous);
  await page.setViewport({ width: 700, height: 850 });
};
