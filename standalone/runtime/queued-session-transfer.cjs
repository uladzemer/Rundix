const { randomUUID, createHash } = require("node:crypto");
const locale = require("../ui/i18n.js");
const { queuedTarget } = require("./queued-edits.cjs");
const { newSessionSettings } = require("./new-session-settings.cjs");
const queueOwners = new WeakMap();

function acquireQueuedSession(source, acquire) {
  let owner = queueOwners.get(source);
  if (!owner) {
    const key =
      "queued-session-" + createHash("sha256").update(source.key).digest("hex");
    owner = { depth: 0, release: acquire(key) };
    queueOwners.set(source, owner);
  }
  owner.depth++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.depth === 0) {
      queueOwners.delete(source);
      owner.release();
    }
  };
}

function transferTarget(source, message, latest) {
  const item = source.followUps?.find((row) => row.id === message.id);
  if (!item?.transferToSession) return queuedTarget(source, message, latest);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.transferToSession))
    throw Error("Invalid queued transfer");
  // A reserved transfer is uncertain only to keep older extension versions from
  // dispatching it. It has not been submitted to the model in this session.
  return queuedTarget(
    {
      ...source,
      followUps: source.followUps.map((row) =>
        row === item ? { ...row, deliveryUncertain: false } : row,
      ),
    },
    message,
    latest,
  );
}

async function transferQueuedSession(source, message, deps) {
  if (source.queueMutation)
    throw Error(locale.t("Дождитесь сохранения очереди."));
  const release = acquireQueuedSession(source, deps.acquire);
  try {
    return await performTransfer(source, message, deps, release);
  } finally {
    release();
  }
}

async function performTransfer(source, message, deps, release) {
  const item = transferTarget(source, message, deps.latest());
  const key = item.transferToSession || randomUUID();
  const existing = deps.destination(key);
  const automaticSend = !item.transferToSession && !existing;
  source.queueMutation = true;
  source.queueDrainDeferred = false;
  async function checkpoint(change) {
    const previousQueue = source.followUps,
      previousRecord = source.persistedRecord;
    change();
    try {
      await deps.save(source);
    } catch (error) {
      if (source.persistedRecord === previousRecord) {
        source.followUps = previousQueue;
        throw error;
      }
      deps.diagnostic("workspace-state-update-failed");
    }
  }
  let destination,
    deferred = false;
  try {
    try {
      await checkpoint(() => {
        source.followUps = source.followUps.map((row) =>
          row.id === item.id
            ? { ...row, deliveryUncertain: true, transferToSession: key }
            : row,
        );
      });
      const settings = newSessionSettings(source, source.cwd);
      const selection = item.modelSelection;
      const record =
        existing ||
        deps.writeDestination({
          key,
          id: null,
          cwd: source.cwd,
          name:
            item.text.trim().replace(/\s+/g, " ").slice(0, 64) ||
            locale.t("Изображение"),
          ...settings,
          model: selection?.model || settings.model,
          effort: selection?.effort || settings.effort,
          prefs: {
            ...settings.prefs,
            ...(selection ? { fast: selection.fast === true } : {}),
          },
          draft: item.text,
          attachments: [...item.attachments],
          items: [],
          followUps: [],
          queuePaused: false,
        });
      destination = deps.open(record);
      // Only a durable, opened destination permits releasing source ownership.
      await checkpoint(() => {
        source.followUps = source.followUps.filter((row) => row.id !== item.id);
      });
    } catch (error) {
      if (
        source.followUps?.some(
          (row) => row.id === item.id && row.transferToSession,
        )
      ) {
        const message = locale.t(
          "Перенос не завершён. Задача сохранена. Нажмите «Открыть новую сессию» в очереди.",
        );
        if (destination) {
          destination.error = message;
          deps.publish(destination);
        }
        throw Error(message);
      }
      throw error;
    } finally {
      deferred = source.queueDrainDeferred;
      source.queueMutation = false;
      source.queueDrainDeferred = false;
      deps.publish(source);
      release();
    }
    // A resumed transfer only opens the saved draft/thread: a prior submission
    // might already have succeeded, so recovery must never automatically replay.
    if (automaticSend) await deps.start(destination, item.modelSelection);
    return destination;
  } finally {
    if (deferred) deps.resume(source);
  }
}

module.exports = { transferQueuedSession, acquireQueuedSession };
