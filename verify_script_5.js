
  let currentRegeneratingDeckId = null;

  async function openDeckRegenerateModal(deckId) {
    try {
      currentRegeneratingDeckId = deckId;
      const deck = await dbGet('decks', deckId);
      if (!deck) {
        alert("Deck record could not be retrieved from local storage.");
        return;
      }

      const titleEl = document.getElementById('regenModalDeckTitle');
      if (titleEl) {
        titleEl.innerText = `Deck: ${deck.title} (${deck.cards ? deck.cards.length : 0} cards)`;
      }

      // 1. Direct saved settings check
      let detectedPreset = deck.presetTag;

      // 2. Title pattern fallback check
      if (!detectedPreset && deck.title) {
        const lowerTitle = deck.title.toLowerCase();
        if (lowerTitle.includes('reviewer mode')) detectedPreset = 'Reviewer Mode (1, 4, 9, 10)';
        else if (lowerTitle.includes('codal mode')) detectedPreset = 'Codal Mode (1–3)';
        else if (lowerTitle.includes('case fir mode')) detectedPreset = 'Case FIR Mode (5–8)';
        else if (lowerTitle.includes('full bar sim')) detectedPreset = 'Full Bar Sim (10/10 Dimensions)';
      }

      // 3. Card dimension and schema fallback check
      if (!detectedPreset && deck.cards && deck.cards.length > 0) {
        const cardDimIds = Array.from(new Set(deck.cards.map(c => {
          const raw = c.dimensionId || c.forcedDimensionId;
          return raw !== undefined && raw !== null ? parseInt(raw, 10) : null;
        }).filter(n => !isNaN(n) && n !== null)));

        const hasAlac = deck.cards.some(c => c.benchmark_alac || c.schemaType === 'ALAC');
        const hasFir = deck.cards.some(c => c.benchmark_fir || c.schemaType === 'FIR');
        const hasCodal = deck.cards.some(c => c.benchmark_codal_breakdown || c.schemaType === 'CODAL');

        if (cardDimIds.length > 0) {
          const isCodal = cardDimIds.every(id => [1, 2, 3].includes(id));
          const isCase = cardDimIds.every(id => [5, 6, 7, 8].includes(id));
          const isReviewer = cardDimIds.every(id => [1, 4, 9, 10].includes(id));

          if (isReviewer) detectedPreset = 'Reviewer Mode (1, 4, 9, 10)';
          else if (isCodal) detectedPreset = 'Codal Mode (1–3)';
          else if (isCase) detectedPreset = 'Case FIR Mode (5–8)';
          else if (cardDimIds.length === 10) detectedPreset = 'Full Bar Sim (10/10 Dimensions)';
          else detectedPreset = `Custom Matrix (${cardDimIds.join(', ')})`;
        } else {
          if (hasAlac && !hasFir) detectedPreset = 'Reviewer Mode (1, 4, 9, 10)';
          else if (hasFir && !hasAlac && !hasCodal) detectedPreset = 'Case FIR Mode (5–8)';
          else if (hasCodal && !hasAlac && !hasFir) detectedPreset = 'Codal Mode (1–3)';
          else detectedPreset = 'Full Bar Sim (10/10 Dimensions)';
        }
      }

      const settingsText = document.getElementById('regenOriginalSettingsText');
      if (settingsText) {
        settingsText.innerText = detectedPreset || 'Reviewer Mode (1, 4, 9, 10)';
      }

      const modal = document.getElementById('deckRegenerateModal');
      if (modal) {
        modal.classList.remove('hidden');
      } else {
        alert("Polish modal element was not found in the DOM.");
      }
    } catch (err) {
      console.error("openDeckRegenerateModal error:", err);
      alert("Could not open Polish Modal: " + err.message);
    }
  }

    function closeDeckRegenerateModal() {
      const modal = document.getElementById('deckRegenerateModal');
      if (modal) modal.classList.add('hidden');
      currentRegeneratingDeckId = null;
    }

    // Explicit global window bindings for cross-platform event dispatch
    window.openDeckRegenerateModal = openDeckRegenerateModal;
    window.closeDeckRegenerateModal = closeDeckRegenerateModal;

  function toggleRegenCustomPreset(isModify) {
    const container = document.getElementById('regenCustomPresetContainer');
    if (container) {
      if (isModify) container.classList.remove('hidden');
      else container.classList.add('hidden');
    }
  }

  async function executeDeckRegeneration() {
    if (!currentRegeneratingDeckId) return;
    const deck = await dbGet('decks', currentRegeneratingDeckId);
    if (!deck || !deck.cards || deck.cards.length === 0) {
      alert("Selected deck contains no cards to polish.");
      return;
    }

    const strategy = document.querySelector('input[name="regenStrategy"]:checked')?.value || 'KEEP';
    const newPreset = document.getElementById('regenNewPresetSelect')?.value || 'ALL';
    const addCloze = document.getElementById('regenAddClozeCheck')?.checked;
    const stripBoilerplate = document.getElementById('regenStripBoilerplateCheck')?.checked;
    const targetCountVal = document.getElementById('regenTargetCountSelect')?.value || 'ORIGINAL';

    closeDeckRegenerateModal();

    let targetCards = [...deck.cards];

    if (targetCountVal !== 'ORIGINAL') {
      const desiredNum = targetCountVal === 'EXPAND' ? Math.max(36, targetCards.length * 2) : parseInt(targetCountVal, 10);
      
      if (desiredNum > targetCards.length) {
        const expandedPool = [];
        let cardIdx = 0;
        while (expandedPool.length < desiredNum) {
          const baseCard = targetCards[cardIdx % targetCards.length];
          const subIdx = Math.floor(cardIdx / targetCards.length) + 1;
          const clone = JSON.parse(JSON.stringify(baseCard));
          if (subIdx > 1) {
            clone.topic = `${clone.topic || clone.case_title} (Part ${subIdx})`;
          }
          expandedPool.push(clone);
          cardIdx++;
        }
        targetCards = expandedPool;
      } else if (desiredNum < targetCards.length) {
        targetCards = targetCards.slice(0, desiredNum);
      }
    }

    showCompileModal(targetCards.length);

    try {
      const polishedCards = [];
      const total = targetCards.length;

      for (let i = 0; i < total; i++) {
        const card = targetCards[i];
        const pct = Math.round(((i + 1) / total) * 100);
        document.getElementById('compileProgressBar').style.width = `${pct}%`;
        document.getElementById('compileProgressPercent').innerText = `${pct}%`;
        document.getElementById('compileCardCounter').innerText = `Polishing Card ${i + 1} of ${total}`;
        document.getElementById('compileCurrentTopic').innerText = card.topic || card.case_title || 'Card Polish';

        if (strategy === 'MODIFY') {
          const profile = PRESET_PROFILES[newPreset] || PRESET_PROFILES.ALL;
          const dId = profile.dims[i % profile.dims.length];
          const dimObj = DIMENSIONS_REGISTRY[dId];
          card.dimensionId = dimObj.id;
          card.exportTag = dimObj.exportTag;
          card.schemaType = dimObj.schemaType;
        }

        let qText = card.question_text || card.question || '';
        if (addCloze && !qText.includes('{{c1::')) {
          qText += `\n\n[Active Recall Cloze Enhanced: Answer key provisions precisely].`;
        }

        if (stripBoilerplate && (qText.toLowerCase().includes('effectivity') || qText.toLowerCase().includes('short title'))) {
          continue;
        }

        polishedCards.push({
          ...card,
          question_text: qText,
          polishedAt: Date.now()
        });

        await new Promise(r => setTimeout(r, 100));
      }

      deck.cards = polishedCards;
      deck.title = `${deck.title.replace(/\s*\(Polished[^\)]*\)/gi, '')} (Polished · ${polishedCards.length} Cards)`;
      deck.presetTag = strategy === 'MODIFY' ? PRESET_PROFILES[newPreset].name : deck.presetTag;

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      hideCompileModal();

      alert(`✨ Successfully polished "${deck.title}" (${polishedCards.length} cards updated)!`);
    } catch (err) {
      hideCompileModal();
      alert("Regeneration failed: " + err.message);
    }
  }
