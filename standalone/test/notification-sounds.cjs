const assert = require('node:assert/strict');
const { CompletionNotifications } = require('../runtime/completion-notifications.cjs');
const { NotificationSettings } = require('../runtime/notification-settings.cjs');
const sounds = require('../runtime/notification-sounds.cjs');

(async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    let saved;
    const notification = new CompletionNotifications({ platform, state: { get: () => saved, update: async (_, value) => { saved = value; } }, secrets: {} });
    assert.equal(notification.getSettings().sound, platform === 'linux' ? '' : 'system');
    await notification.setSettings({ telegram: true });assert.equal(notification.getSettings().sound, platform === 'linux' ? '' : 'system');
    await notification.setSettings({ sound: '' });assert.equal(notification.getSettings().sound, '', 'Explicit mute survives updates');
    await notification.setSettings({ sound: '/custom.wav' });assert.equal(notification.getSettings().sound, '/custom.wav');
    notification.dispose();
  }
  const readDirectory = async directory => {
    assert.equal(directory, '/System/Library/Sounds');return ['Glass.aiff', 'Ping.aiff', 'readme.txt', 'Submarine.AIFF'];
  };
  const files = await sounds.soundFiles('darwin', { readDirectory });
  assert.deepEqual(files.map(file => file.label), ['Glass', 'Ping', 'Submarine']);
  assert.equal(files[0].sound.replaceAll('\\', '/'), '/System/Library/Sounds/Glass.aiff');
  assert.deepEqual(await sounds.soundFiles('darwin', { readDirectory: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } }), []);

  const calls = [];
  const execute = async (...args) => calls.push(args);
  const stat = async () => ({ size: 1024, isFile: () => true });
  await sounds.playSound('system', { platform: 'darwin', execute, stat });
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/osascript', ['-e', 'beep']]);
  const selected = '/System/Library/Sounds/Glass.aiff';
  await sounds.playSound(selected, { platform: 'darwin', execute, stat });
  assert.deepEqual(calls[1].slice(0, 2), ['/usr/bin/afplay', [selected]]);
  await assert.rejects(sounds.playSound('relative.aiff', { platform: 'darwin', execute, stat }));
  await assert.rejects(sounds.playSound('/sound.js', { platform: 'darwin', execute, stat }));
  await assert.rejects(sounds.playSound(selected, { platform: 'darwin', execute, stat: async () => ({ size: 21 * 1024 * 1024, isFile: () => true }) }));
  await sounds.playSound('', { platform: 'darwin', execute, stat });assert.equal(calls.length, 2);

  // Native picker contract: existing file selection, cancellation and explicit mute.
  let value = { sound: 'system', telegram: false, hooks: [] }, preview;
  const notifications = { platform: 'darwin', getSettings: () => value,
    setSettings: async config => { value = config; }, playSound: async file => { preview = file; } };
  const ui = new NotificationSettings({ window: { showQuickPick: async choices => {
    assert.ok(choices.some(item => item.sound === 'system' && item.description));
    return { sound: selected };
  } } }, notifications);
  await ui.sound();assert.equal(value.sound, selected);assert.equal(preview, selected);
  ui.vscode.window.showQuickPick = async () => undefined;await ui.sound();assert.equal(value.sound, selected);
  ui.vscode.window.showQuickPick = async () => ({ sound: '' });await ui.sound();assert.equal(value.sound, '');
  ui.vscode.window.showQuickPick = async () => ({ sound: selected });notifications.playSound = async () => { throw Error('synthetic'); };
  await assert.rejects(ui.sound());assert.equal(value.sound, '', 'Failed preview preserves previous sound');
  console.log('PASS: default-on Windows/macOS sound, preserved mute/custom files, system library choices, safe macOS arguments, picker selection/cancel/preview failure');
})().catch(error => { console.error(error);process.exitCode = 1; });
