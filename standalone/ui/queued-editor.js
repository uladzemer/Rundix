// An independent draft; transcript renders never replace the editor's textarea.
class WorkbenchQueuedEditor {
  constructor({ send, focusComposer, drafts=new Map(), onDraft=()=>{} }) {
    this.send = send;this.drafts=drafts;this.onDraft=onDraft;
    this.focusComposer = focusComposer;
    const node = (tag, text) => {
      const element = document.createElement(tag);
      if (text) element.textContent = WorkbenchI18n.t(text);
      return element;
    };
    this.dialog = node('dialog');this.dialog.className = 'queued-editor';
    this.dialog.setAttribute('aria-labelledby', 'queued-editor-title');
    const title = node('h2', 'Редактировать задачу в очереди');title.id = 'queued-editor-title';
    this.input = node('textarea');this.input.maxLength = 200000;this.input.rows = 8;
    this.input.setAttribute('aria-label', WorkbenchI18n.t('Текст задачи'));
    const hint = node('p', 'Модель и место в очереди сохранятся. Картинку можно вставить через Ctrl+V.');
    this.files = node('div');this.files.className = 'queued-editor-files';
    this.addFiles = node('button', 'Добавить файлы');this.addFiles.type = 'button';this.addFiles.className = 'queued-editor-add';
    this.addFiles.onclick = () => this.addAttachments('pickQueuedFiles');
    this.status = node('p');this.status.setAttribute('role', 'status');
    this.save = node('button', 'Сохранить');this.save.type = 'button';this.save.className = 'primary-button';
    const cancel = node('button', 'Отмена');cancel.type = 'button';
    const actions = node('div');actions.className = 'queued-editor-actions';actions.append(cancel, this.save);
    this.dialog.append(title, this.input, this.files, this.addFiles, hint, this.status, actions);
    document.body.append(this.dialog);
    cancel.onclick = () => this.dialog.close();
    this.save.onclick = () => this.submit();
    this.input.oninput = () => { this.storeDraft();this.refresh(); };
    this.input.addEventListener('paste', event => {
      const images = [...event.clipboardData?.items || []].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();
      if (this.pending || this.uploading || this.reading || this.blocked) return;
      const file = images[0].getAsFile();
      if (!file || file.size > 20 * 1024 * 1024) { this.status.textContent = WorkbenchI18n.t('Поддерживаются PNG, JPEG, GIF и WebP до 20 МБ.');return; }
      const owner = this.owner;
      this.reading = true;this.refresh();
      const reader = new FileReader();
      reader.onload = () => { if (this.owner === owner) { this.reading = false;this.refresh();this.addAttachments('pasteQueuedImage', { dataUrl: reader.result }); } };
      reader.onerror = () => { if (this.owner === owner) { this.reading = false;this.status.textContent = WorkbenchI18n.t('Не удалось прочитать изображение.');this.refresh(); } };
      reader.readAsDataURL(file);
    });
    this.dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault();this.submit(); }
    });
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      if (this.owner) this.send('cancelQueuedEdit', { sessionKey: this.owner.key, editId: this.owner.editId });
      clearTimeout(this.timer);clearTimeout(this.uploadTimer);
      this.pending = null;this.uploading = null;this.reading = false;this.owner = null;this.input.value = '';this.attachments = [];
      this.focusComposer();
    });
  }
  open(item, state) {
    this.owner = { key: state.key, id: item.id, expectedText: item.text || '',
      editId: 'edit-' + Date.now() + '-' + Math.random().toString(36).slice(2) };
    this.attachments = (item.attachments || []).map(file => ({ ...file }));
    // Missing attachment metadata from an older host preserves its original list.
    this.hasAttachmentMetadata = Array.isArray(item.attachments);
    this.originalImages = item.images || 0;
    this.owner.expectedAttachmentIds = this.hasAttachmentMetadata ? this.attachments.map(file => file.id) : undefined;
    this.uploading = null;this.reading = false;this.renderAttachments();
    const saved=this.drafts.get(JSON.stringify([state.key,item.id]));
    this.input.value = saved?.expectedText===this.owner.expectedText ? saved.text : this.owner.expectedText;this.status.textContent = '';this.pending = null;
    this.update(state);this.dialog.showModal();this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }
  storeDraft() {
    if(!this.owner)return;
    this.drafts.set(JSON.stringify([this.owner.key,this.owner.id]),{expectedText:this.owner.expectedText,text:this.input.value});this.onDraft();
  }
  update(state) {
    for(const key of this.drafts.keys()){
      const [session,id]=JSON.parse(key);
      if(session===state.key && !state.followUps?.some(item=>item.id===id)){this.drafts.delete(key);this.onDraft();}
    }
    if (!this.owner) return;
    if (state.key !== this.owner.key) { this.dialog.close();return; }
    const item = state.followUps?.find(row => row.id === this.owner.id);
    this.blocked = !item || item.editable === false || item.deliveryUncertain || state.followUpSending || item.text !== this.owner.expectedText ||
      this.hasAttachmentMetadata && JSON.stringify(item.attachments?.map(file => file.id)) !== JSON.stringify(this.owner.expectedAttachmentIds);
    if (this.blocked && !this.pending) this.status.textContent = WorkbenchI18n.t(!item
      ? 'Задача уже отправлена или удалена из очереди.'
      : state.followUpSending ? 'Дождитесь отправки сообщения из очереди.' : 'Текст задачи уже изменился или недоступен для редактирования.');
    this.refresh();
  }
  refresh() {
    const images = this.hasAttachmentMetadata ? this.attachments.some(file => file.kind === 'image') : this.originalImages;
    this.save.disabled = !!this.pending || !!this.uploading || !!this.reading || !!this.blocked || (!this.input.value.trim() && !images);
    this.input.readOnly = !!this.pending;
    this.addFiles.disabled = !!this.pending || !!this.uploading || !!this.reading || !!this.blocked || !this.hasAttachmentMetadata;
    for (const button of this.files.querySelectorAll('button')) button.disabled = !!this.pending || !!this.uploading || !!this.blocked;
  }
  renderAttachments() {
    this.files.replaceChildren();
    for (const file of this.attachments) {
      const row = document.createElement('div');row.className = 'queued-editor-file';
      const label = document.createElement('span');label.textContent = file.name || WorkbenchI18n.t('Изображение');
      const remove = document.createElement('button');remove.type = 'button';remove.textContent = '×';
      remove.setAttribute('aria-label', WorkbenchI18n.t('Удалить вложение: {0}', label.textContent));
      remove.onclick = () => { this.attachments = this.attachments.filter(item => item.id !== file.id);this.renderAttachments();this.refresh(); };
      row.append(label, remove);this.files.append(row);
    }
  }
  attachmentPayload() {
    return this.hasAttachmentMetadata ? { attachmentIds: this.attachments.map(file => file.id) } : {};
  }
  addAttachments(action, extra = {}) {
    if (!this.owner || this.addFiles.disabled) return;
    const requestId = 'queue-files-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    this.uploading = requestId;this.status.textContent = WorkbenchI18n.t('Добавление вложений…');this.refresh();
    // Native file selection can remain open while the user chooses files.
    this.uploadTimer = setTimeout(() => {
      this.uploading = null;this.status.textContent = WorkbenchI18n.t('Добавление не подтверждено. Откройте задачу заново.');this.blocked = true;this.refresh();
    }, 120000);
    this.send(action, { ...this.owner, sessionKey: this.owner.key, requestId, ...this.attachmentPayload(), ...extra });
  }
  attachmentsResult(message) {
    if (!this.owner || message.key !== this.owner.key || message.editId !== this.owner.editId || message.requestId !== this.uploading) return;
    clearTimeout(this.uploadTimer);this.uploading = null;
    if (message.ok && Array.isArray(message.attachments)) {
      this.attachments = message.attachments;this.status.textContent = '';this.renderAttachments();
    } else this.status.textContent = WorkbenchI18n.t('Не удалось добавить вложения. Проверьте, что задача ещё в очереди.');
    this.refresh();
  }
  submit() {
    if (!this.owner || this.save.disabled) return;
    const requestId = 'queue-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    this.pending = requestId;this.status.textContent = WorkbenchI18n.t('Сохранение…');this.refresh();
    this.timer = setTimeout(() => {
      this.pending = null;this.status.textContent = WorkbenchI18n.t('Сохранение не подтверждено. Проверьте очередь перед повтором.');this.refresh();
    }, 15000);
    this.send('editQueued', { ...this.owner, sessionKey: this.owner.key, requestId, text: this.input.value, ...this.attachmentPayload() });
  }
  finish(message) {
    if (!this.owner || message.key !== this.owner.key || message.requestId !== this.pending) return;
    clearTimeout(this.timer);this.pending = null;
    if (message.ok) { this.drafts.delete(JSON.stringify([this.owner.key,this.owner.id]));this.onDraft();this.dialog.close();return; }
    this.status.textContent = WorkbenchI18n.t('Не удалось сохранить правку. Проверьте, что задача ещё в очереди, и откройте её заново.');
    this.refresh();
  }
  dispose() { clearTimeout(this.timer);clearTimeout(this.uploadTimer);this.owner = null;this.dialog.remove(); }
}
