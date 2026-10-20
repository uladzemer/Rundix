// The credential lease belongs to the CLI login until completion or cancellation.
const LOGIN_TIMEOUT = 10 * 60 * 1000;
class PendingLogin {
  constructor({onFinish, timeout = LOGIN_TIMEOUT}) {
    this.onFinish = onFinish;
    this.timeout = timeout;
    this.current = null;
  }
  begin(client, release) {
    if (this.current) throw Error('Browser sign-in is already pending. Complete or cancel it first.');
    const record = {client, release, id: null};
    this.current = record;
    record.timer = setTimeout(() => {
      void this.cancel(record, 'Browser sign-in timed out. Please try again.').catch(() => {});
    }, this.timeout);
    return record;
  }
  finish(record = this.current, error) {
    if (!record || this.current !== record) return false;
    clearTimeout(record.timer);
    this.current = null;
    record.release();
    this.onFinish(error, record);
    return true;
  }
  complete(client, id) {
    const record = this.current;
    return !!record && record.client === client && record.id === id && this.finish(record);
  }
  async cancel(record = this.current, errorMessage) {
    if (!record || this.current !== record) return;
    try {
      if (record.id) await record.client.request('account/login/cancel', {loginId: record.id});
      else { record.disposed = true; record.client.dispose(); }
    } catch (error) {
      record.disposed = true; record.client.dispose();
      throw error;
    } finally { this.finish(record, errorMessage); }
  }
}
module.exports = {PendingLogin, LOGIN_TIMEOUT};
