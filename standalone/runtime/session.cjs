const locale = require("../ui/i18n.js");
function itemText(item) {
  if (item.type === "userMessage") {
    const text=(item.content || [])
      .map((part) => ['image','localImage'].includes(part.type)?'':part.text || part.path || "")
      .filter(Boolean)
      .join("\n");
    return require('./async-questions.cjs').displayReply(text) || text;
  }
  if (item.type === "agentMessage") return item.text || "";
  if (item.type === "reasoning")
    return (item.summary || item.content || [])
      .map((part) => (typeof part === "string" ? part : part.text || ""))
      .join("\n");
  if (item.type === "commandExecution")
    return [item.command, item.aggregatedOutput].filter(Boolean).join("\n");
  if (item.type === "fileChange")
    return (item.changes || [])
      .map((change) => `${change.path}\n${change.diff || ""}`)
      .join("\n");
  if (item.type === "webSearch")
    return [
      item.action?.query,
      ...(item.action?.queries || []),
      item.action?.url,
    ]
      .filter(Boolean)
      .join("\n");
  if (item.type === "mcpToolCall") {
    const result = item.result?.content || item.content || [];
    return [
      item.server && item.tool ? item.server + " / " + item.tool : item.tool,
      JSON.stringify(item.arguments || {}, null, 2),
      ...(Array.isArray(result) ? result : []).map((part) => part.text || ""),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (item.type === "plan") return item.text || "";
  return JSON.stringify(item, null, 2);
}
function upsert(session, item) {
  const existing = session.items.findIndex((row) => row.id === item.id);
  if (["userMessage", "agentMessage"].includes(item.type) && !Number.isFinite(item.timestamp)) {
    const previousTime = existing >= 0 ? session.items[existing].timestamp : undefined;
    // Only live notifications pass here; history must retain unknown dates.
    item.timestamp = Number.isFinite(previousTime) ? previousTime : Date.now();
  }
  if (existing < 0) session.items.push(item);
  else session.items[existing] = { ...session.items[existing], ...item };
}
function readItem(entry) {
  return {
    ...(entry.item || entry),
    turnId: entry.turnId || entry.item?.turnId,
    timestamp: entry.startedAtMs ?? entry.item?.timestamp ?? entry.timestamp,
  };
}
function copyText(items, itemId, codeIndex) {
  const item = items.find(
    (item) =>
      item.id === itemId && ["userMessage", "agentMessage"].includes(item.type),
  );
  if (!item) throw Error(locale.t("Сообщение не найдено."));
  const text = itemText(item);
  if (codeIndex === undefined) return text;
  if (!Number.isInteger(codeIndex) || codeIndex < 0)
    throw Error(locale.t("Блок кода не найден."));
  const code = require("../ui/markdown.js").codeBlocks(text)[codeIndex];
  if (code === undefined) throw Error(locale.t("Блок кода не найден."));
  return code;
}
function notification(session, message, {serviceMode=false}={}) {
  const p = message.params || {};
  if (!session.id || (p.threadId !== session.id && p.thread?.id !== session.id))
    return false;
  if(session.retrying && p.turnId && p.turnId===session.turnId &&
    ['item/started','item/completed','item/agentMessage/delta','item/commandExecution/outputDelta','item/reasoning/summaryTextDelta'].includes(message.method))session.retrying=false;
  if (
    message.method === "item/started" ||
    message.method === "item/completed"
  ) {
    upsert(session, { ...p.item, ...(p.turnId ? { turnId: p.turnId } : {}) });
    if (p.item?.type === "contextCompaction") {
      session.compacting = message.method === "item/started";
      if (session.compacting) session.usageStale = true;
    }
  } else if (message.method === "item/agentMessage/delta") {
    let item = session.items.find((row) => row.id === p.itemId);
    if (!item) {
      item = { id: p.itemId, type: "agentMessage", text: "" };
      upsert(session, item);
    }
    item.text = (item.text || "") + p.delta;
  } else if (message.method === "item/commandExecution/outputDelta") {
    let item = session.items.find((row) => row.id === p.itemId);
    if (item) item.aggregatedOutput = (item.aggregatedOutput || "") + p.delta;
  } else if (message.method === "item/reasoning/summaryTextDelta") {
    let item = session.items.find((row) => row.id === p.itemId);
    if (!item) {
      item = { id: p.itemId, type: "reasoning", summary: [""] };
      session.items.push(item);
    }
    if (!Array.isArray(item.summary)) item.summary = [""];
    const i = p.summaryIndex || 0;
    item.summary[i] = (item.summary[i] || "") + p.delta;
  } else if (message.method === "turn/started") {
    session.turnId = p.turn.id;
    session.lastStartedTurnId = p.turn.id;
    session.retrying = false;
    session.error = null;
    session.turnStartedAt = Date.now();
    session.busy = true;
  } else if (message.method === "turn/completed") {
    const expected=session.turnId || session.lastStartedTurnId;
    if(expected && p.turn?.id && p.turn.id!==expected)return false;
    session.busy = false;
    session.retrying = false;
    session.compacting = false;
    session.turnId = null;
    session.error = p.turn.error?.message || null;
  } else if (message.method === "thread/closed") {
    // A late close must not unload a thread that a continuation already resumed and is running.
    if (!session.busy) session.loaded = false;
  } else if (message.method === "thread/tokenUsage/updated") {
    session.tokenUsage = p.tokenUsage;
    session.usageModel = session.turnModel || session.model;
    session.usageStale = false;
  } else if (message.method === "thread/name/updated" && !session.customName)
    session.name = p.threadName;
  else if (message.method === "error") {
    if(p.turnId && (session.turnId || session.lastStartedTurnId) && p.turnId!==(session.turnId || session.lastStartedTurnId))return false;
    // A CLI retry is still the same running turn, not a failed send or reconnect request.
    if(p.willRetry===true && session.busy){session.retrying=true;session.error=null;}
    else {session.retrying=false;session.error = p.error?.message || locale.t("Ошибка Codex");}
  }
  else return false;
  return true;
}
module.exports = { itemText, notification, upsert, readItem, copyText };
