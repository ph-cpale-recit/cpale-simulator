
window.CPALE_CORE_SUBJECTS = ['FAR', 'AFAR', 'MS', 'Auditing', 'Taxation', 'RFBT'];
window.toggleCpaleScratchpad = function() {
  const d = document.getElementById('cpaleScratchpadDrawer');
  if (!d) return;
  const hidden = d.classList.contains('hidden') || d.style.display === 'none';
  if (hidden) { d.classList.remove('hidden'); d.style.display = 'block'; } else { d.classList.add('hidden'); d.style.display = 'none'; }
};
window.runCpaleTape = function() {
  const inp = document.getElementById('cpaleCalcInput'), log = document.getElementById('cpaleTapeLog');
  if (!inp || !log || !inp.value.trim()) return;
  const expr = inp.value.replace(/[^0-9+\-*/().\s]/g, '');
  try {
    const val = Function('"use strict";return (' + expr + ')')();
    if (typeof val === 'number' && isFinite(val)) {
      const row = document.createElement('div');
      row.textContent = expr + ' = \u20b1' + val.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
      log.prepend(row); inp.value = String(val);
    }
  } catch (e) {}
};
window.calcCpalePv = function(type) {
  const r = parseFloat(document.getElementById('cpalePvRate')?.value || '0') / 100, n = parseInt(document.getElementById('cpalePvPeriods')?.value || '0', 10), log = document.getElementById('cpaleTapeLog');
  if (!log || r <= 0 || n <= 0) return;
  const factor = type === 'single' ? Math.pow(1 + r, -n) : (1 - Math.pow(1 + r, -n)) / r;
  const row = document.createElement('div'); row.className = 'text-amber-300';
  row.textContent = (type === 'single' ? 'PV of \u20b11' : 'PV Annuity') + ' (' + (r*100).toFixed(2) + '%, n=' + n + ') = ' + factor.toFixed(6);
  log.prepend(row);
};
window.syncCpaleGatekeeperBadge = function(subj) {
  const s = subj || document.getElementById('subjectSelector')?.value || 'FAR';
  const isCore = window.CPALE_CORE_SUBJECTS.includes(s);
  document.querySelectorAll('div, span').forEach(el => {
    if (el.children.length === 0 && el.textContent && (el.textContent.includes('BLOCKED: ATTACH SYLLABUS') || el.textContent.includes('AWAITING ANCHORS') || el.textContent.includes('OFFICIAL PRC '))) el.id = 'cpaleHeaderGatekeeperBadge';
  });
  const badge = document.getElementById('cpaleHeaderGatekeeperBadge');
  if (badge) {
    badge.textContent = isCore ? ('OFFICIAL PRC ' + s + ' SYLLABUS ACTIVE (2022 BOA TOS)') : 'BLOCKED: ATTACH SYLLABUS OR SOURCES';
    badge.className = isCore ? 'inline-block text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-700' : 'inline-block text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-700';
  }
};
const _origSwitchSubject = window.switchActiveSubject;
window.switchActiveSubject = function(val) {
  if (val === '__CUSTOM__') {
    const custom = prompt('Enter Custom Accounting / Review Subject Name (requires syllabus or reference sources to unlock):');
    if (!custom || !custom.trim()) return;
    const clean = custom.trim();
    ['subjectSelector', 'workspaceSubjectSelector'].forEach(selId => {
      const sel = document.getElementById(selId);
      if (sel) { const opt = document.createElement('option'); opt.value = clean; opt.textContent = clean + ' (Custom Subject)'; sel.insertBefore(opt, sel.querySelector('option[value="__CUSTOM__"]')); sel.value = clean; }
    });
    if (typeof _origSwitchSubject === 'function') _origSwitchSubject(clean);
    window.syncCpaleGatekeeperBadge(clean);
    return;
  }
  if (typeof _origSwitchSubject === 'function') _origSwitchSubject(val);
  window.syncCpaleGatekeeperBadge(val);
};
document.addEventListener('DOMContentLoaded', () => setTimeout(() => window.syncCpaleGatekeeperBadge(), 350));
