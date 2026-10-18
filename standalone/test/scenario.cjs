// Deterministic UI audit. Synthetic data; no account requests or project edits.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const puppeteer = require("puppeteer-core");
const output = path.join(__dirname, "../.verification/scenario");
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    pipe: true,
  });
  const report = { synthetic: true, screenshots: [], icons: [], checks: [] };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewport({ width: 820, height: 940 });
    await page.setContent(
      '<html lang="ru" data-language="ru" data-ui-version="0.12.3"><body><main id="app"></main></body></html>',
    );
    await page.addStyleTag({
      content: fs.readFileSync(path.join(__dirname, "../ui/app.css"), "utf8"),
    });
    await page.evaluate(() => {
      window.calls = [];
      window.fixture = {
        key: "audit",
        id: "audit-thread",
        name: "Проверка интерфейса",
        cwd: "D:/demo",
        account: { type: "chatgpt", email: "demo@example.test" },
        model: "demo",
        effort: "medium",
        models: [
          {
            model: "demo",
            displayName: "Demo model",
            description: "Демонстрационная модель",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"].map(
              (reasoningEffort) => ({ reasoningEffort }),
            ),
          },
        ],
        prefs: {
          access: "workspace",
          mode: "workspace",
          ide: true,
          showThinking: true,
          focus: false,
        },
        tokenUsage: {
          last: { totalTokens: 42000 },
          modelContextWindow: 200000,
        },
        usageModel: "demo",
        limits: {
          buckets: [
            {
              id: "codex",
              windows: [
                {
                  key: "primary",
                  minutes: 300,
                  remaining: 65,
                  resetsAt: 1900000000,
                },
                {
                  key: "secondary",
                  minutes: 10080,
                  remaining: 92,
                  resetsAt: 1900400000,
                },
              ],
            },
          ],
          updatedAt: Date.now(),
        },
        items: [],
        requests: [],
        attachments: [],
        busy: false,
      };
      window.update = () =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "state", data: window.fixture },
          }),
        );
      window.acquireVsCodeApi = () => ({
        getState: () => ({}),
        setState: () => {},
        postMessage: (message) => {
          window.calls.push(message);
          if (message.action === "stop") window.fixture.busy = false;
          if (message.action === "settings")
            Object.assign(window.fixture, {
              effort: message.effort || window.fixture.effort,
            });
          if (message.action === "answer") window.fixture.requests = [];
          queueMicrotask(() => {
            window.update();
            if (message.toggleRequestId) window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'toggleResult', requestId: message.toggleRequestId, key: message.sessionKey, ok: true },
            }));
          });
        },
      });
    });
    for (const file of [
      "translations.js",
      "i18n.js",
      "forms.js",
      "questions.js",
      "question-panel.js",
      "task-preflight.js",
      "icons.js",
      "tabs.js",
      "controls.js",
      "toggles.js",
      "modes.js",
      "speed.js",
      "changes.js",
      "limits.js",
      "limits-view.js",
      "markdown.js",
      "markdown-view.js",
      "messages.js",
      "activity.js",
      "transcript-scroll.js",
      "app.js",
    ])
      await page.addScriptTag({
        content: fs.readFileSync(path.join(__dirname, "../ui", file), "utf8"),
      });

    const screenshot = async (name) => {
      await page.screenshot({ path: path.join(output, name + ".png") });
      report.screenshots.push(name + ".png");
    };
    await screenshot("01-empty");
    assert.ok(await page.$eval(".submit-button", (node) => node.disabled));
    const initialHeight = await page.$eval(
      "textarea",
      (node) => node.getBoundingClientRect().height,
    );
    await page.$eval("textarea", (node) => {
      node.value = Array(12)
        .fill("Многострочная задача для проверки ввода")
        .join("\n");
      node.dispatchEvent(new Event("input"));
    });
    assert.ok(
      (await page.$eval(
        "textarea",
        (node) => node.getBoundingClientRect().height,
      )) > initialHeight,
    );
    assert.ok(
      (await page.$eval(
        "textarea",
        (node) => node.getBoundingClientRect().height,
      )) <= 240,
    );
    assert.ok(await page.$eval(".submit-button", (node) => !node.disabled));
    await page.$eval("textarea", (node) => {
      node.value = "";
      node.dispatchEvent(new Event("input"));
    });
    assert.equal(
      await page.$eval(
        "textarea",
        (node) => node.getBoundingClientRect().height,
      ),
      initialHeight,
    );
    assert.equal(await page.$(".session-toolbar .limits-button"), null);
    assert.ok(
      await page.$eval(".context-button", (node) =>
        node.parentElement.classList.contains("footer-right"),
      ),
    );
    assert.ok(
      await page.$eval(
        ".limits-button",
        (node) =>
          node.closest(".local-work-bar") &&
          node.getBoundingClientRect().top >=
            document.querySelector(".composer").getBoundingClientRect().bottom,
      ),
    );
    report.checks.push(
      "Локальная работа и лимиты под вводом; модель и контекст справа",
    );
    assert.ok(
      await page.$eval(".submit-button", (node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.width === rect.height &&
          getComputedStyle(node).borderRadius === "50%"
        );
      }),
    );
    assert.ok(
      await page.$eval(
        ".composer",
        (node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 20,
      ),
    );

    // A visible icon must have painted geometry, not merely an empty SVG element.
    report.icons = await page.evaluate(() => {
      const gallery = document.createElement("div");
      gallery.id = "audit-icons";
      gallery.style.cssText =
        "position:fixed;left:12px;top:48px;z-index:50;background:var(--vscode-editorWidget-background,#252526);padding:16px;display:flex;gap:18px";
      const checks = [];
      for (const name of [
        "send",
        "stop",
        "plus",
        "copy",
        "history",
        "file",
        "bookmark",
        "code",
      ]) {
        const cell = document.createElement("div"),
          svg = icon(name);
        cell.style.cssText =
          "display:flex;flex-direction:column;align-items:center;gap:8px";
        const label = document.createElement("small");
        label.textContent = name;
        cell.append(svg, label);
        gallery.append(cell);
        document.body.append(gallery);
        const paths = [...svg.querySelectorAll("path")];
        checks.push({
          name,
          official: svg.classList.contains("official-icon"),
          painted: paths.some((node) => {
            const box = node.getBBox(),
              style = getComputedStyle(node);
            return (
              box.width > 0 &&
              box.height > 0 &&
              (style.fill !== "none" || style.stroke !== "none")
            );
          }),
        });
      }
      return checks;
    });
    assert.ok(report.icons.every((icon) => icon.official && icon.painted));
    await screenshot("02-official-icons");
    await page.evaluate(() => document.getElementById("audit-icons").remove());

    await page.evaluate(() => {
      window.fixture.busy = true;
      window.fixture.items = [
        {
          id: "user",
          type: "userMessage",
          text: "Добавь проверку пустого имени и покажи результат теста.",
        },
        {
          id: "analysis",
          type: "reasoning",
          text: "Проверю функцию и добавлю отдельный случай для пустой строки.",
          status: "completed",
        },
        {
          id: "cmd",
          type: "commandExecution",
          command: "node --test",
          text: "node --test\n✔ trims a name\n✔ rejects an empty name\n2 tests passed",
          status: "completed",
          exitCode: 0,
          durationMs: 420,
          turnId: "audit-turn",
        },
        {
          id: "edit",
          type: "fileChange",
          status: "completed",
          turnId: "audit-turn",
          changes: [
            {
              path: "D:/demo/src/format-name.js",
              diff: '--- a/src/format-name.js\n+++ b/src/format-name.js\n@@ -1,3 +1,4 @@\n export function formatName(name) {\n-  return name.trim();\n+  const value = name.trim();\n+  return value || "Anonymous";\n }\n',
            },
          ],
        },
        {
          id: "answer",
          type: "agentMessage",
          turnId: "audit-turn",
          text: '## Готово\n\nДобавлена **обработка пустого имени** в [format-name.js](src/format-name.js#L2).\n\n- Сохранил обрезку пробелов.\n- Для пустого значения возвращается `Anonymous`.\n  - Поведение проверено отдельным тестом.\n\n| Проверка | Результат |\n| --- | --- |\n| Обычное имя | Пройдено |\n| Пустая строка | Пройдено |\n\n```javascript\nconst value = name.trim();\nreturn value || "Anonymous";\n```\n\n- [x] Изменён код\n- [x] Пройдены 2 теста\n\n> Это демонстрационные данные для проверки дизайна.',
        },
      ];
      window.update();
    });
    assert.ok(await page.$(".submit-button .official-icon"));
    await page.evaluate(() => {
      window.fixture.items.find((item) => item.id === "cmd").durationMs = 800;
      window.update();
    });
    assert.ok(
      await page.$eval('[data-item-id="cmd"] > summary', (node) =>
        node.textContent.includes("0.8 s"),
      ),
    );
    const stop = await page.$eval(".submit-button path", (node) =>
      node.getAttribute("d"),
    );
    assert.ok(stop.includes("M6 8"));
    await screenshot("03-stream-and-stop");
    await page.click(".submit-button");
    assert.ok(
      await page.evaluate(() =>
        window.calls.some((call) => call.action === "stop"),
      ),
    );
    assert.ok(
      await page.$eval(".submit-button path", (node) =>
        node.getAttribute("d").includes("11.2929"),
      ),
    );
    await page.click('[data-item-id="edit"] > summary');
    await page.click(".inline-diff > summary");
    assert.ok(await page.$(".diff-line-added"));
    assert.ok(await page.$(".diff-line-removed"));
    await screenshot("04-conversation-diff");
    report.checks.push(
      "Официальные SVG имеют видимую геометрию; отправка и остановка переключаются",
      "Markdown, таблица, код, задачи, ссылки, статусы и цветной diff",
    );

    await page.click(".limits-button");
    assert.ok(
      await page.$eval(
        ".limits-menu",
        (node) =>
          node.textContent.includes("65%") && node.textContent.includes("92%"),
      ),
    );
    await screenshot("05-limits-bottom");
    await page.keyboard.press("Escape");
    await page.click(".model-button");
    assert.ok(await page.$(".reasoning-slider"));
    await screenshot("06-model");
    await page.click(".model-button");
    assert.equal(
      await page.$(".model-menu"),
      null,
      "Second click closes the model menu",
    );
    await page.click(".model-button");
    await page.keyboard.press("Escape");
    await page.click(".footer-left .dropdown");
    await screenshot("07-permissions");
    await page.keyboard.press("Escape");
    await page.click('button[aria-label="Команды (/)"]');
    assert.ok(await page.$(".command-list .menu-row .ui-icon"));
    assert.ok(
      await page.$$eval(".command-list .menu-row", (rows) =>
        rows.every((row) => {
          const bounds = row.getBoundingClientRect();
          return [...row.querySelectorAll("strong,small")].every((text) => {
            const rect = text.getBoundingClientRect();
            return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
          });
        }),
      ),
      "Command labels stay within their rows after adding icons",
    );
    await screenshot("08-commands");
    await page.type(".command-search", "контекст");
    const keptMenu = await page.evaluate(() => {
      window.keptSearch = document.querySelector(".command-search");
      window.keptSearch.setSelectionRange(2, 4);
      window.fixture.items.at(-1).text += " обновление";
      window.update();
      return (
        window.keptSearch === document.querySelector(".command-search") &&
        document.activeElement === window.keptSearch
      );
    });
    assert.ok(keptMenu, "Streaming keeps the command search and its focus");
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      window.fixture.busy = true;
      window.fixture.requests = [
        {
          id: "approval",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "audit-thread",
            command: "node --test",
            cwd: "D:/demo",
            reason: "Проверить изменение перед завершением",
          },
        },
      ];
      window.update();
    });
    assert.ok(await page.$(".approval"));
    await screenshot("09-approval");
    await page.evaluate(() => {
      window.fixture.busy = false;
      window.fixture.requests = [];
      window.update();
    });
    report.checks.push(
      "Модель/глубина, режимы доступа, поиск команд и подтверждение команды",
    );

    for (const width of [340, 700, 1200]) {
      await page.setViewport({ width, height: 900 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.ok(
        await page.$eval(".submit-button", (node) => {
          const r = node.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth;
        }),
      );
      await screenshot("10-responsive-" + width);
    }
    await page.setViewport({ width: 820, height: 940 });
    for (const height of [360, 540]) {
      await page.setViewport({ width: 540, height });
      for (const selector of [
        ".model-button",
        ".limits-button",
        'button[aria-label="Команды (/)"]',
      ]) {
        await page.click(selector);
        assert.ok(
          await page.$eval(".menu", (node) => {
            const r = node.getBoundingClientRect();
            return (
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              r.left >= 0 &&
              r.right <= innerWidth
            );
          }),
          "Menu fits a short window",
        );
        await page.keyboard.press("Escape");
      }
    }
    await page.setViewport({ width: 820, height: 940 });
    await page.evaluate(() => {
      document.documentElement.style.cssText =
        "--vscode-editor-background:#fff;--vscode-foreground:#242424;--vscode-descriptionForeground:#616161;--vscode-input-background:#f7f7f7;--vscode-input-foreground:#242424;--vscode-input-placeholderForeground:#656565;--vscode-widget-border:#d5d5d5;--vscode-textBlockQuote-background:#f0f0f0;--vscode-textCodeBlock-background:#f5f5f5;--vscode-editorWidget-background:#f5f5f5;--vscode-textLink-foreground:#006ab1;--vscode-gitDecoration-addedResourceForeground:#18752b;--vscode-gitDecoration-deletedResourceForeground:#b52020";
    });
    await screenshot("11-light-theme");
    report.checks.push(
      "Без горизонтального переполнения на 340/700/1200 px; светлая и тёмная темы",
    );
    assert.deepEqual(errors, []);
    report.passed = true;
    console.log(
      "PASS: design scenario, visible official icons, stop/send, limits placement, diff, menus, approval, responsive widths and themes.",
    );
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
