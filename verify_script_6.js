
(function() {
  window.selectedDeckIds = new Set();

  window.selectAllSavedDecks = function() {
    document.querySelectorAll('#deckListContainer input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  };

  window.unselectAllSavedDecks = function() {
    document.querySelectorAll('#deckListContainer input[type="checkbox"]').forEach(cb => {
      if (cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  };

  function updateLaunchSelectedBtn() {
    let btn = document.getElementById('launchSelectedDecksBtn');
    const section = document.getElementById('savedDecksSection');
    if (!section) return;
    const headerRow = section.querySelector('div');
    if (!headerRow) return;

    if (!document.getElementById('harnessDeckSelectionGroup')) {
      const grp = document.createElement('div');
      grp.id = 'harnessDeckSelectionGroup';
      grp.className = 'inline-flex items-center space-x-1.5 ml-2';
      grp.innerHTML =
        '<button type="button" id="harnessSelectAllBtn" onclick="selectAllSavedDecks()" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 rounded-lg font-mono text-[10px] font-bold transition">Select All</button>' +
        '<button type="button" id="harnessUnselectAllBtn" onclick="unselectAllSavedDecks()" class="px-2 py-1 bg-slate-800 hover:bg-red-950/80 disabled:opacity-40 text-slate-200 hover:text-red-200 border border-slate-700 hover:border-red-800 rounded-lg font-mono text-[10px] font-bold transition">Unselect</button>';
      headerRow.insertBefore(grp, headerRow.children[1] || null);
    }

    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'launchSelectedDecksBtn';
      btn.type = 'button';
      btn.className = 'px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-slate-950 font-bold rounded-lg font-mono text-xs transition shadow';
      btn.onclick = openMultiDeckBatchModal;
      headerRow.insertBefore(btn, headerRow.children[2] || null);
    }

    const totalCheckboxes = document.querySelectorAll('#deckListContainer input[type="checkbox"]').length;
    const count = window.selectedDeckIds.size;
    btn.innerText = 'Launch Selected Decks (' + count + ')';
    btn.disabled = count === 0;

    const selBtn = document.getElementById('harnessSelectAllBtn');
    const unselBtn = document.getElementById('harnessUnselectAllBtn');
    if (selBtn) selBtn.disabled = (totalCheckboxes === 0 || count === totalCheckboxes);
    if (unselBtn) unselBtn.disabled = (count === 0);
  }

  if (typeof window.renderDeckListUI === 'function') {
    const origRenderDecks = window.renderDeckListUI;
    window.renderDeckListUI = async function(...args) {
      const res = await origRenderDecks.apply(this, args);
      const decks = await dbGetAll('decks');
      decks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const rows = document.querySelectorAll('#deckListContainer > div');
      rows.forEach((row, idx) => {
        const deck = decks[idx];
        if (!deck || row.querySelector('.deck-multi-cb')) return;
        const titleEl = row.querySelector('span.font-bold');
        if (!titleEl) return;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'deck-multi-cb mr-2.5 w-4 h-4 rounded bg-slate-900 border-slate-700 text-amber-500 cursor-pointer';
        cb.checked = window.selectedDeckIds.has(deck.id);
        cb.onchange = function() {
          if (cb.checked) window.selectedDeckIds.add(deck.id);
          else window.selectedDeckIds.delete(deck.id);
          updateLaunchSelectedBtn();
        };
        titleEl.parentElement.insertBefore(cb, titleEl);
      });
      updateLaunchSelectedBtn();
      return res;
    };
  }

  async function openMultiDeckBatchModal() {
    const allDecks = await dbGetAll('decks');
    const chosenDecks = allDecks.filter(d => window.selectedDeckIds.has(d.id));
    if (chosenDecks.length === 0) return;

    let playablePool = [];
    chosenDecks.forEach(d => {
      (d.cards || []).forEach(c => {
        if (!c.isSuspended && !isCardBuriedToday(c)) {
          playablePool.push({ ...c, _parentDeckId: d.id });
        }
      });
    });

    if (playablePool.length === 0) {
      alert('Selected decks have 0 playable cards.');
      return;
    }

    let modal = document.getElementById('multiDeckBatchModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'multiDeckBatchModal';
      modal.className = 'fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[80] flex items-center justify-center p-4';
      modal.innerHTML = '<div class="bg-slate-900 border border-amber-600/70 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">' +
        '<h3 class="font-serif font-bold text-amber-400 text-lg">Batch Configuration</h3>' +
        '<div class="text-xs font-mono text-slate-300 space-y-1">' +
          '<div>Total Decks: <b id="mdDeckCount" class="text-amber-300">0</b></div>' +
          '<div>Total Playable Cards: <b id="mdCardCount" class="text-emerald-400">0</b></div>' +
        '</div>' +
        '<div>' +
          '<label class="block text-[11px] font-mono text-slate-400 mb-1">Batch Size:</label>' +
          '<select id="mdBatchSizeSelect" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200">' +
            '<option value="10">10 cards</option>' +
            '<option value="15" selected>15 cards</option>' +
            '<option value="25">25 cards</option>' +
            '<option value="0">Unbatched (all cards)</option>' +
          '</select>' +
        '</div>' +
        '<div class="flex justify-end space-x-2 pt-2">' +
          '<button type="button" id="mdCancelBtn" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-mono">Cancel</button>' +
          '<button type="button" id="mdStartBtn" class="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold rounded-lg text-xs font-mono">Start Session</button>' +
        '</div>' +
      '</div>';
      document.body.appendChild(modal);
      document.getElementById('mdCancelBtn').onclick = () => modal.classList.add('hidden');
    }

    document.getElementById('mdDeckCount').innerText = chosenDecks.length;
    document.getElementById('mdCardCount').innerText = playablePool.length;
    modal.classList.remove('hidden');

    document.getElementById('mdStartBtn').onclick = async function() {
      const bSize = parseInt(document.getElementById('mdBatchSizeSelect').value, 10);
      const shouldShuffle = document.getElementById('shuffleDeckCheckbox')?.checked;
      const ordered = shouldShuffle ? shuffleArray(playablePool) : [...playablePool];

      state.batchedSets = (bSize > 0)
        ? Array.from({ length: Math.ceil(ordered.length / bSize) }, (_, i) => ordered.slice(i * bSize, (i + 1) * bSize))
        : [ordered];

      modal.classList.add('hidden');
      const setupModal = document.getElementById('setupModal');
      if (setupModal) setupModal.classList.add('hidden');

      await requestScreenWakeLock();
      state.isSessionActive = true;
      state.activeDeckTitle = chosenDecks.length === 1 ? chosenDecks[0].title : 'Multi-Deck (' + chosenDecks.length + ' Decks)';
      document.getElementById('progressDisplay')?.classList.remove('hidden');
      await launchBatch(0);
    };
  }

  function ensureSessionDeleteButton() {
    const modal = document.getElementById('cardCreatorModal');
    if (!modal) return;
    const saveBtn = document.getElementById('saveAndCloseCardBtn');
    const footerRow = saveBtn ? saveBtn.parentElement?.parentElement : null;
    if (!footerRow) return;

    let delBtn = document.getElementById('harnessSessionDeleteBtn');
    if (!delBtn) {
      delBtn = document.createElement('button');
      delBtn.id = 'harnessSessionDeleteBtn';
      delBtn.type = 'button';
      delBtn.className = 'px-3.5 py-2 bg-red-950/90 hover:bg-red-900 text-red-200 border border-red-700 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 cursor-pointer';
      delBtn.innerHTML = '<span>🗑️ Delete Card</span>';
      delBtn.onclick = async function() {
        if (!state.activeAgenda || state.activeAgenda.length === 0) return;
        const idx = state.currentQuestionIndex - 1;
        const card = state.activeAgenda[idx];
        if (!card) return;
        const title = card.topic || card.case_title || ('Card ' + state.currentQuestionIndex);
        if (!confirm('Permanently delete "' + title + '" from this session and its parent deck?')) return;

        state.activeAgenda.splice(idx, 1);
        if (Array.isArray(state.activeDeckCardsPool)) {
          state.activeDeckCardsPool = state.activeDeckCardsPool.filter(c => (c.topic || c.case_title) !== (card.topic || card.case_title));
        }
        if (Array.isArray(state.sessionTranscript)) {
          state.sessionTranscript = state.sessionTranscript.filter(t => t.topic !== title);
        }

        const allDecks = await dbGetAll('decks');
        for (const d of allDecks) {
          if (!Array.isArray(d.cards)) continue;
          const origLen = d.cards.length;
          d.cards = d.cards.filter(c => (c.topic || c.case_title) !== (card.topic || card.case_title) || c.question_text !== card.question_text);
          if (d.cards.length !== origLen) {
            await dbSave('decks', d);
          }
        }
        if (typeof renderDeckListUI === 'function') await renderDeckListUI();

        state.totalQuestions = state.activeAgenda.length;
        const totalEl = document.getElementById('totalQNum');
        if (totalEl) totalEl.innerText = state.totalQuestions;

        if (typeof closeCardCreatorModal === 'function') closeCardCreatorModal();
        else modal.classList.add('hidden');

        if (state.activeAgenda.length === 0) {
          if (typeof proceedToNextQuestion === 'function') await proceedToNextQuestion();
          return;
        }
        if (state.currentQuestionIndex > state.totalQuestions) {
          state.currentQuestionIndex = state.totalQuestions;
        }
        await launchActiveCard(state.currentQuestionIndex);
      };
      footerRow.insertBefore(delBtn, footerRow.firstChild);
    }
    delBtn.classList.toggle('hidden', !state.isSessionActive);
  }

  if (typeof window.editActiveCardInPlace === 'function') {
    const origEdit = window.editActiveCardInPlace;
    window.editActiveCardInPlace = async function(...args) {
      const res = await origEdit.apply(this, args);
      ensureSessionDeleteButton();
      return res;
    };
  }
})();
