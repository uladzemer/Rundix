function tabTitle(name) {
  // VS Code uses this title for the native hover as well as the visible label.
  // Let its tab sizing clip the label while preserving the full hover text.
  return String(name || 'Rundix').replace(/\s+/g,' ').trim() || 'Rundix';
}
module.exports={tabTitle};
