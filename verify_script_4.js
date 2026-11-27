
    // ---------------------------------------------------------------------------
    // CROSS-DEVICE SNAPSHOT PAIRING & SYNC SUBSYSTEM (6-DIGIT PIN RELAY)
    // ---------------------------------------------------------------------------
    // Public zero-signup ephemeral relay endpoint (15-min auto-purge)
    const PIN_RELAY_BASE = 'https://bar-recit-sync.gabrielmateo826.workers.dev/';

    async function generateCompleteMasterPayload() {
      const meta = await dbGetAllRaw('metadata');
      const mastery = await dbGetAllRaw('mastery');
      const decks = await dbGetAllRaw('decks');

      // Optimization: Omit heavy digests if many decks exist (for speed/limits)
      const digests = (decks.length >= 15) ? [] : await dbGetAllRaw('digests');

      // Strip heavy raw source texts from PIN sync to keep payload under relay size limits (< 50KB)
      const rawSources = await dbGetAllRaw('sources');
      const lightweightSources = rawSources.map(s => ({
        id: s.id,
        subject: s.subject,
        name: s.name,
        text: '' // Omits multi-megabyte raw PDF text; decks and digests handle active study items
      }));

      return {
        format: "ph_bar_recit_pin_sync_v1",
        syncTimestamp: Date.now(),
        syncDate: new Date().toISOString(),
        subject: currentSubjectName,
        metadata: meta,
        sources: lightweightSources,
        digests: (decks && decks.length >= 15) ? [] : digests,
        mastery: mastery,
        decks: decks
      };
    }

    async function generateDeviceSyncPIN() {
      const btnText = document.getElementById('pinBtnText');
      const spinner = document.getElementById('pinSpinner');
      const pinBox = document.getElementById('generatedPinDisplay');
      const pinVal = document.getElementById('pinValue');

      if (btnText) btnText.innerText = "Packaging Decks...";
      if (spinner) spinner.classList.remove('hidden');

      try {
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const formattedPin = `${pin.substring(0, 3)}-${pin.substring(3)}`;

        const payload = await generateCompleteMasterPayload();
        const payloadString = JSON.stringify(payload);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        let res;
        try {
          res = await fetch(`${PIN_RELAY_BASE}sync_${pin}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payloadString,
            signal: controller.signal
          });
        } catch (fetchErr) {
          throw new Error("Cloud sync relay unreachable (CORS, ad-blocker, or offline): " + fetchErr.message);
        } finally {
          clearTimeout(timeoutId);
        }

        if (!res.ok) throw new Error(`Relay error (Status ${res.status}).`);

        if (pinVal) pinVal.innerText = formattedPin;
        if (pinBox) pinBox.classList.remove('hidden');
        if (btnText) btnText.innerText = "New PIN";

        const badge = document.getElementById('headerSyncStatusBadge');
        if (badge) {
          badge.innerText = `PIN: ${formattedPin}`;
          badge.className = "font-mono text-[11px] px-1.5 py-0.5 rounded bg-amber-950/70 border border-amber-800 text-amber-300";
        }

        alert(`Sync PIN Ready: ${formattedPin}\n\nEnter this 6-digit code on Device B under Setup and tap 'Pull & Merge'. Valid for 15 minutes.`);
      } catch (err) {
        console.warn("Relay sync unavailable, invoking file fallback:", err);
        const useFallback = confirm(`⚠️ Wireless PIN Relay Unavailable (${err.message}).\n\nWould you like to export a direct Sync Snapshot (.json) file instead? You can send it via AirDrop, Bluetooth, or Drive to Device B.`);
        if (useFallback) {
          await exportWorkspaceJSON();
        }
        if (btnText) btnText.innerText = "Generate 6-Digit PIN";
      } finally {
        if (spinner) spinner.classList.add('hidden');
      }
    }

    async function pullDeviceSyncPIN() {
      const input = document.getElementById('inputPairPin');
      const rawPin = (input?.value || '').replace(/[^0-9]/g, '');

      if (rawPin.length !== 6) {
        alert("Please enter a valid 6-digit PIN (e.g. 519204).");
        return;
      }

      const btn = document.getElementById('pullSyncPinBtn');
      const originalText = btn ? btn.innerText : "Pull & Merge";
      if (btn) {
        btn.innerText = "Downloading...";
        btn.disabled = true;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        let res;
        try {
          res = await fetch(`${PIN_RELAY_BASE}sync_${rawPin}`, { signal: controller.signal });
        } catch (fetchErr) {
          throw new Error("Cloud sync relay unreachable: " + fetchErr.message);
        } finally {
          clearTimeout(timeoutId);
        }

        if (!res.ok) {
          throw new Error("Invalid or expired PIN.");
        }

        const remotePayload = await res.json();
        if (!remotePayload || !remotePayload.decks) {
          throw new Error("Malformed payload received from relay.");
        }

        // Non-destructively merge Decks
        const localDecks = await dbGetAllRaw('decks');
        const localDeckMap = new Map(localDecks.map(d => [d.id, d]));

        for (const remDeck of remotePayload.decks || []) {
          const existing = localDeckMap.get(remDeck.id);
          if (!existing) {
            await dbSave('decks', remDeck);
          } else {
            const remTime = new Date(remDeck.createdAt || 0).getTime();
            const locTime = new Date(existing.createdAt || 0).getTime();
            if (remTime >= locTime || (remDeck.cards && remDeck.cards.length > (existing.cards ? existing.cards.length : 0))) {
              await dbSave('decks', remDeck);
            }
          }
        }

        // Non-destructively merge Mastery records
        const localMastery = await dbGetAllRaw('mastery');
        const localMasteryMap = new Map(localMastery.map(m => [m.id, m]));

        for (const remM of remotePayload.mastery || []) {
          const existing = localMasteryMap.get(remM.id);
          if (!existing) {
            await dbSave('mastery', remM);
          } else {
            const remTested = new Date(remM.lastTested || 0).getTime();
            const locTested = new Date(existing.lastTested || 0).getTime();
            if (remTested >= locTested) {
              await dbSave('mastery', remM);
            }
          }
        }

        // Merge Syllabi, metadata & sources
        for (const remMeta of remotePayload.metadata || []) {
          await dbSave('metadata', remMeta);
        }
        for (const remSource of remotePayload.sources || []) {
          await dbSave('sources', remSource);
        }
        for (const remDigest of remotePayload.digests || []) {
          await dbSave('digests', remDigest);
        }

        await stampSubjectModifiedTimestamp();
        await refreshMasteryStatsUI();
        await renderDeckListUI();
        evaluateGatekeeperState();

        const badge = document.getElementById('headerSyncStatusBadge');
        if (badge) {
          badge.innerText = "✓ Synced via PIN";
          badge.className = "font-mono text-[11px] px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-800 text-emerald-300";
        }

        alert(`✅ Synced Successfully!\n\nImported ${remotePayload.decks.length} deck(s) and ${remotePayload.mastery.length} mastery records.`);
        if (input) input.value = '';
      } catch (err) {
        console.warn("PIN Pull failed, opening file import fallback:", err);
        const useFallback = confirm(`⚠️ Could not reach wireless relay (${err.message}).\n\nWould you like to import a Sync Snapshot (.json) file from Device A instead?`);
        if (useFallback) {
          document.getElementById('importBackupInput')?.click();
        }
      } finally {
        if (btn) {
          btn.innerText = originalText;
          btn.disabled = false;
        }
      }
    }

    function openDriveHealthModal() {
      // Repurposed to open setup modal directly to Sync tab
      toggleModal('setupModal');
    }
    let currentSubjectName = localStorage.getItem('bar_active_subject') || 'FAR';
    const DB_NAME = 'BarRecitUniversalMasterDB_v14_1';
    const DB_VERSION = 141;
    let db;
    let isCompilingActive = false;
    let wakeLockSentinel = null;

    async function requestScreenWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLockSentinel = await navigator.wakeLock.request('screen');
        } catch (_) {}
      }
    }

    async function releaseScreenWakeLock() {
      if (wakeLockSentinel) {
        try {
          await wakeLockSentinel.release();
          wakeLockSentinel = null;
        } catch (_) {}
      }
    }

    function switchActiveSubject(newSub) {
      if (newSub === '__CUSTOM__') {
        const custom = prompt("Enter the name of your new subject (e.g. Criminal Law, Civil Law, Labor Law, Taxation):");
        if (!custom || !custom.trim()) {
          const sel = document.getElementById('subjectSelector');
          if (sel) sel.value = currentSubjectName;
          return;
        }
        newSub = custom.trim();
      }
      localStorage.setItem('bar_active_subject', newSub);
      window.location.reload();
    }

    // ---------------------------------------------------------------------------
    // 10-DIMENSION ARCHETYPE REGISTRY & PRESET PROFILES (ATOMIC ISOLATION)
    // ---------------------------------------------------------------------------
    const DIMENSIONS_REGISTRY = {
      1: {
        id: 1,
        code: "DEF_NATURE",
        label: "1. Legal Definition & Nature Only (Concept, Scope & Policy)",
        shortTag: "DIM 1 · DEFINITION & NATURE ONLY",
        exportTag: "Legal Definition & Policy",
        category: "CODAL",
        schemaType: "CODAL",
        placeholder: "DEFINITION & NATURE ONLY:\nState the statutory or doctrinal definition, legal nature, scope of application, and underlying policy (do not list elements or exceptions unless part of the core definition)..."
      },
      2: {
        id: 2,
        code: "ELEMENTS_REQ",
        label: "2. Essential Elements & Requisites Only (Numbered Enumeration)",
        shortTag: "DIM 2 · ESSENTIAL REQUISITES ONLY",
        exportTag: "Essential Elements & Requisites",
        category: "CODAL",
        schemaType: "CODAL",
        placeholder: "ESSENTIAL ELEMENTS & REQUISITES ONLY:\nEnumerate all mandatory statutory or doctrinal requisites in a clean numbered list:\n(1) ...\n(2) ...\n(3) ..."
      },
      3: {
        id: 3,
        code: "STAT_EXCEPTIONS",
        label: "3. Statutory & Jurisprudential Exceptions Only (Provisos & Case Exceptions)",
        shortTag: "DIM 3 · STATUTORY & CASE EXCEPTIONS",
        exportTag: "Statutory Provisos & Jurisprudential Exceptions",
        category: "CODAL",
        schemaType: "CODAL",
        placeholder: "STATUTORY PROVISOS & JURISPRUDENTIAL EXCEPTIONS:\nA. Statutory Exceptions / Provisos:\n(1) ...\n\nB. Jurisprudential / Case-Law Exceptions & Qualifications:\n(1) ..."
      },
      4: {
        id: 4,
        code: "DOCTRINAL_DISTINCTION",
        label: "4. Doctrinal Distinctions (Structured Comparative Prose)",
        shortTag: "DIM 4 · DOCTRINAL DISTINCTION",
        exportTag: "Doctrinal Distinction",
        category: "REVIEWER",
        schemaType: "ALAC",
        placeholder: "COMPARATIVE DISTINCTION:\nContrast the two concepts in structured comparative paragraphs covering: (1) Definition & Nature; (2) Governing Rule / Requisites; (3) Scope & Legal Effect..."
      },
      5: {
        id: 5,
        code: "CASE_FACTS_POSTURE",
        label: "5. Case Facts & Procedural Posture (Socratic Fact Grilling)",
        shortTag: "DIM 5 · CASE FACTS & POSTURE",
        exportTag: "Case Facts & Procedural Posture",
        category: "CASE",
        schemaType: "FIR",
        placeholder: "OPERATIVE FACTS & PROCEDURAL POSTURE:\nState the parties, the material operative facts that triggered the dispute, and how the lower courts ruled before reaching the Supreme Court..."
      },
      6: {
        id: 6,
        code: "CASE_HOLDING_RATIO",
        label: "6. Case Holding & Ratio Decidendi (Controlling Legal Test)",
        shortTag: "DIM 6 · HOLDING & RATIO DECIDENDI",
        exportTag: "Case Holding & Ratio Decidendi",
        category: "CASE",
        schemaType: "FIR",
        placeholder: "SUPREME COURT HOLDING & RATIO DECIDENDI:\nState the categorical disposition of the Supreme Court and explain the controlling legal doctrine / test established in this precedent..."
      },
      7: {
        id: 7,
        code: "CASE_FULL_FIR",
        label: "7. Complete Case Brief (Full FIR Cold Call)",
        shortTag: "DIM 7 · COMPLETE CASE BRIEF (FIR)",
        exportTag: "Complete Case Brief (FIR)",
        category: "CASE",
        schemaType: "FIR",
        placeholder: "FACTS: (State the material operative facts: parties, subject matter, and controversy)\n\nISSUE: (State the precise legal question resolved by the Supreme Court)\n\nRULING & RATIO: (State the categorical ruling and controlling ratio decidendi)..."
      },
      8: {
        id: 8,
        code: "CASE_DUAL_SYNTHESIS",
        label: "8. Comparative Precedent Synthesis (Case X vs. Case Y)",
        shortTag: "DIM 8 · DUAL-CASE SYNTHESIS (X vs. Y)",
        exportTag: "Comparative Precedent Synthesis",
        category: "CASE",
        schemaType: "COMPARATIVE_FIR",
        placeholder: "CASE 1 (FACTS, ISSUE & RULING):\n\nCASE 2 (FACTS, ISSUE & RULING):\n\nCOMPARATIVE SYNTHESIS: Explain the factual hinge or doctrinal reason why the Supreme Court reached these rulings..."
      },
      9: {
        id: 9,
        code: "BAR_HYPOTHETICAL",
        label: "9. Bar Problem Hypotheticals (4-Part ALAC Application)",
        shortTag: "DIM 9 · BAR HYPOTHETICAL (ALAC)",
        exportTag: "Bar Problem Hypothetical (ALAC)",
        category: "REVIEWER",
        schemaType: "ALAC",
        placeholder: "A - DIRECT ANSWER: (Yes/No/Admissible/Inadmissible)\n\nL - LEGAL BASIS: (Cite the governing codal section or Supreme Court doctrine)\n\nA - APPLICATION: (Apply the rule strictly to the facts of the problem)\n\nC - CONCLUSION: (State your definitive conclusion)..."
      },
      10: {
        id: 10,
        code: "PROCEDURAL_REMEDIES",
        label: "10. Procedural Remedies & Defenses (Vehicles & Bars)",
        shortTag: "DIM 10 · PROCEDURAL REMEDIES & BARS",
        exportTag: "Procedural Remedies & Bars",
        category: "REVIEWER",
        schemaType: "ALAC",
        placeholder: "PROCEDURAL REMEDY / DEFENSE:\nIdentify the proper procedural vehicle, forum, prescriptive period, or affirmative bar under the Rules of Court and jurisprudence..."
      }
    };

    const PRESET_PROFILES = {
      CODAL: { name: "Computational MCQs (1–2)", dims: [1, 2] },
      CASE: { name: "Theory & Standards (3–4)", dims: [3, 4] },
      REVIEWER: { name: "Audit & Caselets (5–6)", dims: [5, 6] },
      ALL: { name: "Full Board Sim (6/6)", dims: [1, 2, 3, 4, 5, 6] }
    };

    // ---------------------------------------------------------------------------
    // CANONICAL 2019 REVISED RULES ON EVIDENCE VERBATIM REGISTRY (RULE 128-130)
    // ---------------------------------------------------------------------------
    const CANONICAL_2019_CODAL_MAP = {
      "128:1": { title: "Evidence defined", text: "Section 1. Evidence defined. — Evidence is the means, sanctioned by these rules, of ascertaining in a judicial proceeding the truth respecting a matter of fact. (1)" },
      "128:2": { title: "Scope", text: "Section 2. Scope. — The rules of evidence shall be the same in all courts and in all trials and hearings, except as otherwise provided by law or these rules. (2)" },
      "128:3": { title: "Admissibility of evidence", text: "Section 3. Admissibility of evidence. — Evidence is admissible when it is relevant to the issue and not excluded by the Constitution, the law or these Rules. (3a)" },
      "128:4": { title: "Relevancy; collateral matters", text: "Section 4. Relevancy; collateral matters. — Evidence must have such a relation to the fact in issue as to induce belief in its existence or non-existence. Evidence on collateral matters shall not be allowed, except when it tends in any reasonable degree to establish the probability or improbability of the fact in issue. (4)" },
      "129:1": { title: "Judicial notice, when mandatory", text: "Section 1. Judicial notice, when mandatory. — A court shall take judicial notice, without the introduction of evidence, of the existence and territorial extent of states, their political history, forms of government and symbols of nationality, the law of nations, the admiralty and maritime courts of the world and their seals, the political constitution and history of the Philippines, official acts of the legislative, executive and judicial departments of the National Government of the Philippines, the laws of nature, the measure of time, and the geographical divisions. (1a)" },
      "129:2": { title: "Judicial notice, when discretionary", text: "Section 2. Judicial notice, when discretionary. — A court may take judicial notice of matters which are of public knowledge, or are capable of unquestionable demonstration, or ought to be known to judges because of their judicial functions. (2)" },
      "129:3": { title: "Judicial notice, when hearing necessary", text: "Section 3. Judicial notice, when hearing necessary. — During the pre-trial and the trial, the court, motu proprio or upon motion, shall hear the parties on the propriety of taking judicial notice of any matter. Before judgment or on appeal, the court, motu proprio or upon motion, may take judicial notice of any matter and shall hear the parties thereon if such matter is decisive of a material issue in the case. (3a)" },
      "129:4": { title: "Judicial admissions", text: "Section 4. Judicial admissions. — An admission, oral or written, made by the party in the course of the proceedings in the same case, does not require proof. The admission may be contradicted only by showing that it was made through palpable mistake or that the imputed admission was not, in fact, made. (4a)" },
      "130:1": { title: "Object as evidence", text: "Section 1. Object as evidence. — Objects as evidence are those addressed to the senses of the court. When an object is relevant to the fact in issue, it may be exhibited to, examined or viewed by the court. (1)" },
      "130:2": { title: "Documentary evidence", text: "Section 2. Documentary evidence. — Documents as evidence consist of writings, recordings, photographs or any material containing letters, words, sounds, numbers, figures, symbols, or their equivalent, or other modes of written expression offered as proof of their contents. Photographs include still pictures, drawings, stored images, x-ray films, motion pictures or videos. (2a)" },
      "130:3": { title: "Original document must be produced; exceptions", text: "Section 3. Original document must be produced; exceptions. — When the subject of inquiry is the contents of a document, writing, recording, photograph or other record, no evidence is admissible other than the original document itself, except in the following cases:\n(a) When the original is lost or destroyed, or cannot be produced in court, without bad faith on the part of the offeror;\n(b) When the original is in the custody or under the control of the party against whom the evidence is offered, and the latter fails to produce it after reasonable notice, or the original cannot be obtained by local judicial processes or procedures;\n(c) When the original consists of numerous accounts or other documents which cannot be examined in court without great loss of time and the fact sought to be established from them is only the general result of the whole;\n(d) When the original is a public record in the custody of a public officer or is recorded in a public office; and\n(e) When the original is not closely-related to a controlling issue. (3a)" },
      "130:4": { title: "Original of document", text: "Section 4. Original of document. — (a) An \"original\" of a document is the document itself or any counterpart intended to have the same effect by a person executing or issuing it. An \"original\" of a photograph includes the negative or any print therefrom. If data is stored in a computer or similar device, any printout or other output readable by sight or other means, shown to reflect the data accurately, is an \"original.\"\n(b) A \"duplicate\" is a counterpart produced by the same impression as the original, or from the same matrix, or by means of photography, including enlargements and miniatures, or by mechanical or electronic re-recording, or by chemical reproduction, or by other equivalent techniques which accurately reproduce the original.\n(c) A duplicate is admissible to the same extent as an original unless (1) a genuine question is raised as to the authenticity of the original, or (2) in the circumstances, it is unjust or inequitable to admit the duplicate in lieu of the original. (4a)" },
      "130:5": { title: "When original document is unavailable", text: "Section 5. When original document is unavailable. — When the original document has been lost or destroyed, or cannot be produced in court, the offeror, upon proof of its execution or existence and the cause of its unavailability without bad faith on his or her part, may prove its contents by a copy, or by a recital of its contents in some authentic document, or by the testimony of witnesses in the order stated. (5a)" },
      "130:6": { title: "When original document is in adverse party's custody or control", text: "Section 6. When original document is in adverse party's custody or control. — If the document is in the custody or under the control of the adverse party, he or she must have reasonable notice to produce it. If after such notice and after satisfactory proof of its existence, he or she fails to produce the document, secondary evidence may be presented as in the case of its loss. (6a)" },
      "130:7": { title: "Summaries", text: "Section 7. Summaries. — When the contents of documents, records, photographs, or numerous accounts are voluminous and cannot be examined in court without great loss of time, and the fact sought to be established is only the general result of the whole, the contents of such evidence may be presented in the form of a chart, summary, or calculation. The originals shall be available for examination or copying, or both, by the adverse party at a reasonable time and place. The court may order that they be produced in court. (n)" },
      "130:8": { title: "Evidence admissible when original document is a public record", text: "Section 8. Evidence admissible when original document is a public record. — When the original of a document is in the custody of a public officer or is recorded in a public office, its contents may be proved by a certified copy issued by the public officer in custody thereof. (7)" },
      "130:9": { title: "Party who calls for document not bound to offer it", text: "Section 9. Party who calls for document not bound to offer it. — A party who calls for the production of a document and inspects the same is not obliged to offer it as evidence. (8)" },
      "130:10": { title: "Evidence of written agreements (Parol Evidence Rule)", text: "Section 10. Evidence of written agreements. — When the terms of an agreement have been reduced to writing, it is considered as containing all the terms agreed upon and there can be, as between the parties and their successors in interest, no evidence of such terms other than the contents of the written agreement.\nHowever, a party may present evidence to modify, explain or add to the terms of the written agreement if he or she puts in issue in a verified pleading:\n(a) An intrinsic ambiguity, mistake or imperfection in the written agreement;\n(b) The failure of the written agreement to express the true intent and agreement of the parties thereto;\n(c) The validity of the written agreement; or\n(d) The existence of other terms agreed to by the parties or their successors in interest after the execution of the written agreement.\nThe term \"agreement\" includes wills. (9a)" },
      "130:21": { title: "Witnesses; their qualifications", text: "Section 21. Witnesses; their qualifications. — All persons who can perceive, and perceiving, can make known their perception to others, may be witnesses. Religious or political belief, interest in the outcome of the case, or conviction of a crime, unless otherwise provided by law, shall not be a ground for disqualification. (20)" },
      "130:22": { title: "Testimony confined to personal knowledge", text: "Section 22. Testimony confined to personal knowledge. — A witness can testify only to those facts which he or she knows of his or her personal knowledge; that is, which are derived from his or her own perception. (36a)" },
      "130:23": { title: "Disqualification by reason of marriage", text: "Section 23. Disqualification by reason of marriage. — During their marriage, the husband or the wife cannot testify against the other without the consent of the affected spouse, except in a civil case by one against the other, or in a criminal case for a crime committed by one against the other or the latter's direct descendants or ascendants. (22a)" },
      "130:24": { title: "Disqualification by reason of privileged communication", text: "Section 24. Disqualification by reason of privileged communication. — The following persons cannot testify as to matters learned in confidence in the following cases:\n(a) The husband or the wife, during or after the marriage, cannot be examined without the consent of the other as to any communication received in confidence by one from the other during the marriage except in a civil case by one against the other, or in a criminal case for a crime committed by one against the other or the latter's direct descendants or ascendants;\n(b) An attorney or person reasonably believed by the client to be licensed to engage in the practice of law cannot, without the consent of the client, be examined as to any communication made by the client to him or her, or his or her advice given thereon in the course of, or with a view to, professional employment, nor can an attorney's secretary, stenographer, or clerk, or other persons assisting the attorney be examined without the consent of the client and his or her employer, concerning any fact the knowledge of which has been acquired in such capacity, except in the following cases: (i) Furtherance of crime or fraud; (ii) Claimants through same deceased client; (iii) Breach of duty by lawyer or client; (iv) Document attested by the lawyer; or (v) Joint clients.\n(c) A physician, psychotherapist or person reasonably believed by the patient to be authorized to practice medicine or psychotherapy cannot in a civil case, without the consent of the patient, be examined as to any confidential communication made for the purpose of diagnosis or treatment of the patient's physical, mental or emotional condition, including alcohol or drug addiction, between the patient and his or her physician or psychotherapist.\n(d) A minister, priest or person reasonably believed to be so cannot, without the consent of the affected person, be examined as to any communication or confession made to or any advice given by him or her, in his or her professional character, in the course of discipline enjoined by the church to which the minister or priest belongs.\n(e) A public officer cannot be examined during or after his or her tenure as to communications made to him or her in official confidence, when the court finds that the public interest would suffer by the disclosure. (24a)" },
      "130:25": { title: "Parental and filial privilege", text: "Section 25. Parental and filial privilege. — No person shall be compelled to testify against his or her parents, other direct ascendants, children or other direct descendants, except when such testimony is indispensable in a crime against that person or by one parent against the other. (25a)" },
      "130:26": { title: "Privilege relating to trade secrets", text: "Section 26. Privilege relating to trade secrets. — A person cannot be compelled to testify about any trade secret, unless the non-disclosure will conceal fraud or otherwise work injustice. (n)" },
      "130:27": { title: "Admission of a party", text: "Section 27. Admission of a party. — The act, declaration or omission of a party as to a relevant fact may be given in evidence against him or her. (26a)" },
      "130:28": { title: "Offer of compromise not admissible", text: "Section 28. Offer of compromise not admissible. — In civil cases, an offer of compromise is not an admission of any liability, and is not admissible in evidence against the offeror. Neither is evidence of conduct nor statements made in compromise negotiations admissible, except evidence otherwise discoverable or offered for another purpose, such as proving bias or prejudice of a witness, negativing a contention of undue delay, or proving an effort to obstruct a criminal investigation or prosecution.\nIn criminal cases, except those involving quasi-offenses (criminal negligence) or those allowed by law to be compromised, an offer of compromise by the accused may be received in evidence as an implied admission of guilt. (27a)" },
      "130:29": { title: "Admission by third party (Res Inter Alios Acta)", text: "Section 29. Admission by third party. — The rights of a party cannot be prejudiced by an act, declaration, or omission of another, except as hereinafter provided. (28)" },
      "130:30": { title: "Admission by co-partner or agent", text: "Section 30. Admission by co-partner or agent. — The act or declaration of a partner or agent authorized by the party to make a statement concerning the subject, or within the scope of his or her authority, and during the existence of the partnership or agency, may be given in evidence against such party after the partnership or agency is shown by evidence other than such act or declaration. (29a)" },
      "130:31": { title: "Admission by conspirator", text: "Section 31. Admission by conspirator. — The act or declaration of a conspirator in furtherance of the conspiracy and during its existence may be given in evidence against the co-conspirator after the conspiracy is shown by evidence other than such act of declaration. (30a)" },
      "130:32": { title: "Admission by privies", text: "Section 32. Admission by privies. — Where one derives title to property from another, the latter's act, declaration, or omission, in relation to the property, is evidence against the former if done while the latter was holding the title. (31a)" },
      "130:33": { title: "Admission by silence", text: "Section 33. Admission by silence. — An act or declaration made in the presence and within the hearing or observation of a party who does or says nothing when the act or declaration is such as naturally to call for action or comment if not true, and when proper and possible for him or her to do so, may be given in evidence against him or her. (32a)" },
      "130:34": { title: "Confession", text: "Section 34. Confession. — The declaration of an accused acknowledging his or her guilt of the offense charged, or of any offense necessarily included therein, may be given in evidence against him or her. (33a)" },
      "130:35": { title: "Similar acts as evidence", text: "Section 35. Similar acts as evidence. — Evidence that one did or did not do a certain thing at one time is not admissible to prove that he or she did or did not do the same or similar thing at another time; but it may be received to prove a specific intent or knowledge, identity, plan, system, scheme, habit, custom or usage, and the like. (34a)" },
      "130:36": { title: "Unaccepted offer", text: "Section 36. Unaccepted offer. — An offer in writing to pay a particular sum of money or to deliver a written instrument or specific personal property is, if rejected without valid cause, equivalent to the actual production and tender of the money, instrument, or property. (35)" },
      "130:37": { title: "Hearsay", text: "Section 37. Hearsay. — Hearsay is a statement other than one made by the declarant while testifying at a trial or hearing, offered to prove the truth of the facts asserted therein. A statement is (1) an oral or written assertion or (2) a non-verbal conduct of a person, if it is intended by him or her as an assertion. Hearsay evidence is inadmissible except as otherwise provided in these Rules.\nA statement is not hearsay if the declarant testifies at the trial or hearing and is subject to cross-examination concerning the statement, and the statement is (a) inconsistent with the declarant's testimony, and was given under oath subject to the penalty of perjury at a trial, hearing, or other proceeding, or in a deposition; (b) consistent with the declarant's testimony and is offered to rebut an express or implied charge against the declarant of recent fabrication or improper influence or motive; or (c) one of identification of a person made after perceiving him or her. (n)" },
      "130:38": { title: "Dying declaration", text: "Section 38. Dying declaration. — The declaration of a dying person, made under the consciousness of an impending death, may be received in any case wherein his or her death is the subject of inquiry, as evidence of the cause and surrounding circumstances of such death. (37a)" },
      "130:39": { title: "Statement of decedent or person of unsound mind", text: "Section 39. Statement of decedent or person of unsound mind. — In an action against an executor or administrator or other representative of a deceased person, or against a person of unsound mind, upon a claim or demand against the estate of such deceased person or against such person of unsound mind, where a party or assignor of a party or a person in whose behalf a case is prosecuted testifies on a matter of fact occurring before the death of the deceased person or before the person became of unsound mind, any statement of the deceased or the person of unsound mind, may be received in evidence if the statement was made upon the personal knowledge of the deceased or the person of unsound mind at a time when the matter had been recently perceived by him or her and while his or her recollection was clear. Such statement, however, is inadmissible if made under circumstances indicating its lack of trustworthiness. (23a)" },
      "130:40": { title: "Declaration against interest", text: "Section 40. Declaration against interest. — The declaration made by a person deceased or unable to testify against the interest of the declarant, if the fact asserted in the declaration was at the time it was made so far contrary to the declarant's own interest that a reasonable person in his or her position would not have made the declaration unless he or she believed it to be true, may be received in evidence against himself or herself or his or her successors in interest and against third persons. A statement tending to expose the declarant to criminal liability and offered to exculpate the accused is not admissible unless corroborating circumstances clearly indicate the trustworthiness of the statement. (38a)" },
      "130:41": { title: "Act or declaration about pedigree", text: "Section 41. Act or declaration about pedigree. — The act or declaration of a person deceased, or unable to testify, in respect to the pedigree of another person related to him or her by birth, adoption, or marriage or, in the absence thereof, with whose family he or she was so intimately associated as to be likely to have accurate information concerning his or her pedigree, may be received in evidence where it occurred before the controversy, and the relationship between the two persons is shown by evidence other than such act or declaration. The word \"pedigree\" includes relationship, family genealogy, birth, marriage, death, the dates when and the places where these facts occurred, and the names of the relatives. It embraces also facts of family history intimately connected with pedigree. (39a)" },
      "130:42": { title: "Family reputation or tradition regarding pedigree", text: "Section 42. Family reputation or tradition regarding pedigree. — The reputation or tradition existing in a family previous to the controversy, in respect to the pedigree of any one of its members, may be received in evidence if the witness testifying thereon be also a member of the family, either by consanguinity, affinity, or adoption. Entries in family bibles or other family books or charts, engraving on rings, family portraits and the like, may be received as evidence of pedigree. (40a)" },
      "130:43": { title: "Common reputation", text: "Section 43. Common reputation. — Common reputation existing previous to the controversy, as to boundaries of or customs affecting lands in the community and reputation as to events of general history important to the community, or respecting marriage or moral character, may be given in evidence. Monuments and inscriptions in public places may be received as evidence of common reputation. (41a)" },
      "130:44": { title: "Part of the res gestae", text: "Section 44. Part of the res gestae. — Statements made by a person while a startling occurrence is taking place or immediately prior or subsequent thereto, under the stress of excitement caused by the occurrence with respect to the circumstances thereof, may be given in evidence as part of the res gestae. So, also, statements accompanying an equivocal act material to the issue, and giving it a legal significance, may be received as part of the res gestae. (42a)" },
      "130:45": { title: "Records of regularly conducted business activity", text: "Section 45. Records of regularly conducted business activity. — A memorandum, report, record or data compilation of acts, events, conditions, opinions, or diagnoses, made by writing, typing, electronic, optical or other similar means at or near the time of or from transmission or supply of information by a person with knowledge thereof, and kept in the regular course or conduct of a business activity, and such was the regular practice to make the memorandum, report, record, or data compilation by electronic, optical or similar means, all of which are shown by the testimony of the custodian or other qualified witnesses, is excepted from the rule on hearsay evidence. (43a)" },
      "130:46": { title: "Entries in official records", text: "Section 46. Entries in official records. — Entries in official records made in the performance of his or her duty by a public officer of the Philippines, or by a person in the performance of a duty specially enjoined by law, are prima facie evidence of the facts therein stated. (44a)" },
      "130:47": { title: "Commercial lists and the like", text: "Section 47. Commercial lists and the like. — Evidence of statements of matters of interest to persons engaged in an occupation contained in a list, register, periodical, or other published compilation is admissible as tending to prove the truth of any relevant matter so stated if that compilation is published for use by persons engaged in that occupation and is generally used and relied upon by them therein. (45)" },
      "130:48": { title: "Learned treatises", text: "Section 48. Learned treatises. — A published treatise, periodical or pamphlet on a subject of history, law, science, or art is admissible as tending to prove the truth of a matter stated therein if the court takes judicial notice, or a witness expert in the subject testifies, that the writer of the statement in the treatise, periodical or pamphlet is recognized in his or her profession or calling as expert in the subject. (46a)" },
      "130:49": { title: "Testimony or deposition at a former proceeding", text: "Section 49. Testimony or deposition at a former proceeding. — The testimony or deposition of a witness deceased or out of the Philippines or who cannot, with due diligence, be found therein, or is unavailable or otherwise unable to testify, given in a former case or proceeding, judicial or administrative, involving the same parties and subject matter, may be given in evidence against the adverse party who had the opportunity to cross-examine him or her. (47a)" },
      "130:50": { title: "Residual exception", text: "Section 50. Residual exception. — A statement not specifically covered by any of the foregoing exceptions, having equivalent circumstantial guarantees of trustworthiness, is admissible if the court determines that (a) the statement is offered as evidence of a material fact; (b) the statement is more probative on the point for which it is offered than any other evidence which the proponent can procure through reasonable efforts; and (c) the general purposes of these Rules and the interests of justice will be best served by admission of the statement into evidence. However, a statement may not be admitted under this exception unless the proponent makes known to the adverse party, sufficiently in advance of the hearing, or by the pre-trial stage in the case of a trial of the main case, to provide the adverse party with a fair opportunity to prepare to meet it, the proponent's intention to offer the statement and the particulars of it, including the name and address of the declarant. (n)" },
      "130:51": { title: "General rule (Opinion Rule)", text: "Section 51. General rule. — The opinion of a witness is not admissible, except as indicated in the following sections. (48)" },
      "130:52": { title: "Opinion of expert witness", text: "Section 52. Opinion of expert witness. — The opinion of a witness on a matter requiring special knowledge, skill, experience, training or education, which he or she is shown to possess, may be received in evidence. (49a)" },
      "130:53": { title: "Opinion of ordinary witnesses", text: "Section 53. Opinion of ordinary witnesses. — The opinion of a witness, for which proper basis is given, may be received in evidence regarding — (a) the identity of a person about whom he or she has adequate knowledge; (b) a handwriting with which he or she has sufficient familiarity; and (c) the mental sanity of a person with whom he or she is sufficiently acquainted. The witness may also testify on his or her impressions of the emotion, behavior, condition or appearance of a person. (50a)" },
      "130:54": { title: "Character evidence not generally admissible; exceptions", text: "Section 54. Character evidence not generally admissible; exceptions. — Evidence of a person's character or a trait of character is not admissible for the purpose of proving action in conformity therewith on a particular occasion, except:\n(a) In Criminal Cases: (1) The character of the offended party may be proved if it tends to establish in any reasonable degree the probability or improbability of the offense charged. (2) The accused may prove his or her good moral character, pertinent to the moral trait involved in the offense charged. However, the prosecution may not prove his or her bad moral character unless on rebuttal.\n(b) In Civil Cases: Evidence of the moral character of a party in a civil case is admissible only when pertinent to the issue of character involved in the case.\n(c) In Criminal and Civil Cases: Evidence of the good character of a witness is not admissible until such character has been impeached. (51a)" },
      // RULE 133: WEIGHT AND SUFFICIENCY OF EVIDENCE (COMPLETE UNTRUNCATED TEXT)
      "133:1": { title: "Preponderance of evidence, how determined", text: "Section 1. Preponderance of evidence, how determined. — In civil cases, the party having the burden of proof must establish his or her case by a preponderance of evidence. In determining where the preponderance or superior weight of evidence on the issues involved lies, the court may consider all the facts and circumstances of the case, the witnesses' manner of testifying, their intelligence, their means and opportunity of knowing the facts to which they are testifying, the nature of the facts to which they testify, the probability or improbability of their testimony, their interest or want of interest, and also their personal credibility so far as the same may legitimately appear upon the trial. The court may also consider the number of witnesses, though the preponderance is not necessarily with the greater number. (1a)" },
      "133:2": { title: "Proof beyond reasonable doubt", text: "Section 2. Proof beyond reasonable doubt. — In a criminal case, the accused is entitled to an acquittal, unless his or her guilt is shown beyond reasonable doubt. Proof beyond reasonable doubt does not mean such a degree of proof as, excluding possibility of error, produces absolute certainty. Moral certainty only is required, or that degree of proof which produces conviction in an unprejudiced mind. (2a)" },
      "133:3": { title: "Extrajudicial confession, not sufficient ground for conviction", text: "Section 3. Extrajudicial confession, not sufficient ground for conviction. — An extrajudicial confession made by an accused shall not be a sufficient ground for conviction, unless corroborated by evidence of corpus delicti. (3)" },
      "133:4": { title: "Circumstantial evidence, when sufficient", text: "Section 4. Circumstantial evidence, when sufficient. — Circumstantial evidence is sufficient for conviction if:\n(a) There is more than one circumstance;\n(b) The facts from which the inferences are derived are proven; and\n(c) The combination of all the circumstances is such as to produce a conviction beyond reasonable doubt.\nInferences cannot be based on other inferences. (4a)" },
      "133:5": { title: "Weight to be given opinion of expert witness, how determined", text: "Section 5. Weight to be given opinion of expert witness, how determined. — In any case where the opinion of an expert witness is received in evidence, the court has a wide latitude of discretion in determining the weight to be given to such opinion, and for that purpose may consider the following:\n(a) Whether the opinion is based upon sufficient facts or data;\n(b) Whether it is the product of reliable principles and methods;\n(c) Whether the witness has applied the principles and methods reliably to the facts of the case;\n(d) In the case of scientific opinion, the testability of the opinion, whether it was subjected to peer review and publication, the known or potential rate of error, and the general acceptance of the theory, technique, or method in the relevant scientific community; and\n(e) The witness's qualification, experience, and the extent of his or her specialized knowledge. (n)" },
      "133:6": { title: "Substantial evidence", text: "Section 6. Substantial evidence. — In cases filed before administrative or quasi-judicial bodies, a fact may be deemed established if it is supported by substantial evidence, or that amount of relevant evidence which a reasonable mind might accept as adequate to justify a conclusion. (5)" },
      "133:7": { title: "Power of the court to stop further evidence", text: "Section 7. Power of the court to stop further evidence. — The court may stop the introduction of further testimony upon any particular point when the evidence upon it is already so full that more witnesses to the same point cannot be reasonably expected to be additionally persuasive. But this power should be exercised with caution. (6)" },
      "133:8": { title: "Evidence on motion", text: "Section 8. Evidence on motion. — When a motion is based on facts not appearing of record the court may hear the matter on affidavits or depositions presented by the respective parties, but the court may direct that the matter be heard wholly or partly on oral testimony or depositions. (7)" }
    };

    // ---------------------------------------------------------------------------
    // UNIVERSAL MULTI-SUBJECT CANONICAL STATUTORY REGISTRY
    // ---------------------------------------------------------------------------
    const UNIVERSAL_SUBJECT_CODAL_REGISTRY = {
      "Civil Law": {
        "1156": { title: "Obligation defined", text: "Article 1156. An obligation is a juridical necessity to give, to do or not to do." },
        "1157": { title: "Sources of obligations", text: "Article 1157. Obligations arise from: (1) Law; (2) Contracts; (3) Quasi-contracts; (4) Acts or omissions punished by law; and (5) Quasi-delicts." },
        "1170": { title: "Breach of obligations (Fraud, Negligence, Delay)", text: "Article 1170. Those who in the performance of their obligations are guilty of fraud, negligence, or delay, and those who in any manner contravene the tenor thereof, are liable for damages." },
        "1174": { title: "Fortuitous event", text: "Article 1174. Except in cases expressly specified by the law, or when it is otherwise declared by stipulation, or when the nature of the obligation requires the assumption of risk, no person shall be responsible for those events which could not be foreseen, or which, though foreseen, were inevitable." },
        "1191": { title: "Tacit resolutory condition / Rescission in reciprocal obligations", text: "Article 1191. The power to rescind obligations is implied in reciprocal ones, in case one of the obligors should not comply with what is incumbent upon him. The injured party may choose between the fulfillment and the rescission of the obligation, with the payment of damages in either case." },
        "1305": { title: "Contract defined", text: "Article 1305. A contract is a meeting of minds between two persons whereby one binds himself, with respect to the other, to give something or to render some service." },
        "1318": { title: "Essential requisites of contracts", text: "Article 1318. There is no contract unless the following requisites concur: (1) Consent of the contracting parties; (2) Object certain which is the subject matter of the contract; (3) Cause of the obligation which is established." },
        "FC:35": { title: "Void marriages", text: "Family Code Art. 35. The following marriages shall be void from the beginning: (1) Contracted by any party below 18 years of age even with parental consent; (2) Solemnized by unauthorized officer; (3) Solemnized without license; (4) Bigamous or polygamous; (5) Mistake as to identity; (6) Subsequent marriages void under Art. 53." },
        "FC:36": { title: "Psychological incapacity", text: "Family Code Art. 36. A marriage contracted by any party who, at the time of the celebration, was psychologically incapacitated to comply with the essential marital obligations of marriage, shall likewise be void even if such incapacity becomes manifest only after its solemnization. (Governed En Banc by Tan-Andal v. Andal, G.R. No. 196359, recognizing it as a legal, not medical concept)." }
      },
      "Criminal Law": {
        "11": { title: "Justifying circumstances", text: "Article 11. Justifying circumstances. — The following do not incur any criminal liability: (1) Self-defense (Requisites: Unlawful aggression, reasonable necessity of means employed, lack of sufficient provocation); (2) Defense of relatives; (3) Defense of strangers; (4) Avoidance of greater evil or injury; (5) Fulfillment of duty or lawful exercise of right/office; (6) Obedience to an order issued by a superior for some lawful purpose." },
        "12": { title: "Exempting circumstances", text: "Article 12. Circumstances which exempt from criminal liability. — The following are exempt: (1) An imbecile or an insane person; (2) A person under 15 years of age (R.A. 9344 as amended); (3) A person over 15 and under 18 unless acted with discernment; (4) Performing a lawful act with due care causing injury by mere accident; (5) Compulsion of an irresistible force; (6) Impulse of an uncontrollable fear; (7) Prevented by some lawful or insuperable cause." },
        "14": { title: "Aggravating circumstances", text: "Article 14. Aggravating circumstances. — The following are aggravating circumstances: (1) That advantage be taken by the offender of his public position; (2) In contempt of or with insult to the public authorities; (3) With insult or in disregard of respect due the offended party on account of rank, age, or sex, or committed in dwelling; (14) With evident premeditation; (15) With craft, fraud, or disguise; (16) With treachery (alevosia); (17) With ignominy; (21) With cruelty." },
        "248": { title: "Murder", text: "Article 248. Murder. — Any person who, not falling within the provisions of Article 246 (Parricide), shall kill another, shall be guilty of murder and punished by reclusion perpetua, if committed with any of the following attendant circumstances: (1) Treachery, taking advantage of superior strength, with aid of armed men, or employing means to weaken defense; (2) In consideration of price, reward, or promise; (3) By means of inundation, fire, poison, explosion, or derailment; (4) On occasion of calamities; (5) With evident premeditation; (6) With cruelty or outraging corpse." },
        "266-A": { title: "Rape (Amended by R.A. 11648)", text: "Article 266-A. Rape. — Rape is committed: (1) By a man who shall have carnal knowledge of another person through force, threat, or intimidation; or when the offended party is deprived of reason or unconscious; or by fraudulent machination; or (2) When the offended party is under 16 years of age (R.A. 11648 statutory rape threshold, subject to close-in-age exemption under Sec. 2)." }
      },
      "Labor Law": {
        "297": { title: "Termination by employer (Just causes)", text: "Article 297 [279]. Termination by employer. — An employer may terminate an employment for any of the following just causes: (a) Serious misconduct or willful disobedience by the employee of the lawful orders of his employer or representative in connection with his work; (b) Gross and habitual neglect by the employee of his duties; (c) Fraud or willful breach by the employee of the trust reposed in him by his employer or duly authorized representative; (d) Commission of a crime or offense by the employee against the person of his employer or any immediate member of his family or duly authorized representatives; and (e) Other causes analogous to the foregoing." },
        "298": { title: "Closure of establishment and reduction of personnel (Authorized causes)", text: "Article 298 [280]. Authorized causes. — The employer may also terminate the employment of any employee due to: (1) The installation of labor-saving devices; (2) Redundancy; (3) Retrenchment to prevent losses; or (4) The closing or cessation of operation of the establishment or undertaking, unless the closing is for the purpose of circumventing the provisions of this Title." }
      },
      "Legal Ethics": {
        "CPRA:2": { title: "Canon II: Propriety", text: "A lawyer shall, at all times, act with propriety and maintain the appearance of propriety in personal and professional dealings, observing dignity, respect, and fairness." },
        "CPRA:3": { title: "Canon III: Fidelity", text: "Fidelity pertains to a lawyer's duty to preserve the client's confidences, avoid conflicts of interest, and account for all money and property received from the client with scrupulous fidelity." }
      }
    };
// ---------------------------------------------------------------------------
    // SPECIAL RULES & ADMINISTRATIVE CIRCULARS TOPIC REGISTRY
    // ---------------------------------------------------------------------------
    const SPECIAL_RULES_TOPIC_REGISTRY = {
      "dna": [
        { topic: "Rule on DNA Evidence: Definition of DNA, DNA Profile, and DNA Testing (Sec. 3)", rule: "A.M. No. 06-11-5-SC, Sec. 3" },
        { topic: "Rule on DNA Evidence: Application & Order for DNA Testing (Requisites & Discretion) (Sec. 4)", rule: "A.M. No. 06-11-5-SC, Sec. 4" },
        { topic: "Rule on DNA Evidence: Factors in Granting DNA Testing Order (Sec. 4-5)", rule: "A.M. No. 06-11-5-SC, Sec. 4-5" },
        { topic: "Rule on DNA Evidence: Post-Conviction DNA Testing (Requisites & Procedure) (Sec. 6)", rule: "A.M. No. 06-11-5-SC, Sec. 6" },
        { topic: "Rule on DNA Evidence: Assessment and Evaluation of DNA Results (Weight & Integrity) (Sec. 7-8)", rule: "A.M. No. 06-11-5-SC, Sec. 7-8" },
        { topic: "Rule on DNA Evidence: Post-Trial / Post-Conviction Relief based on Favorable DNA Result (Sec. 10)", rule: "A.M. No. 06-11-5-SC, Sec. 10" },
        { topic: "Rule on DNA Evidence: Confidentiality of DNA Profiles & Penalties (Sec. 11)", rule: "A.M. No. 06-11-5-SC, Sec. 11" }
      ],
      "child witness": [
        { topic: "Examination of Child Witness: Presumption of Competency & Competency Hearing (Sec. 6)", rule: "A.M. No. 004-07-SC, Sec. 6" },
        { topic: "Examination of Child Witness: Oath or Affirmation & Examination Mode (Sec. 7-8)", rule: "A.M. No. 004-07-SC, Sec. 7-8" },
        { topic: "Examination of Child Witness: Leading Questions, Impairment & Objections (Sec. 19-20)", rule: "A.M. No. 004-07-SC, Sec. 19-20" },
        { topic: "Examination of Child Witness: Live-Link Television / Screens & Video Testimony (Sec. 25)", rule: "A.M. No. 004-07-SC, Sec. 25" },
        { topic: "Examination of Child Witness: Hearsay Exception in Child Abuse Cases (Requisites) (Sec. 28)", rule: "A.M. No. 004-07-SC, Sec. 28" },
        { topic: "Examination of Child Witness: Support Persons and Waiting Room Safeguards (Sec. 5 & 23)", rule: "A.M. No. 004-07-SC, Sec. 5" },
        { topic: "Examination of Child Witness: Sexual Abuse Shield Rule & Corroboration (Sec. 22 & 30)", rule: "A.M. No. 004-07-SC, Sec. 22" }
      ],
      "electronic evidence": [
        { topic: "Rule on Electronic Evidence: Definition of Electronic Document & Data Message (Rule 2)", rule: "A.M. No. 01-7-01-SC, Rule 2" },
        { topic: "Rule on Electronic Evidence: Admissibility and Burden of Proving Authenticity (Rule 3)", rule: "A.M. No. 01-7-01-SC, Rule 3" },
        { topic: "Rule on Electronic Evidence: Electronic Signature & Secure Electronic Signature (Rule 5)", rule: "A.M. No. 01-7-01-SC, Rule 5" },
        { topic: "Rule on Electronic Evidence: Audio, Photographic, Video and Ephemeral Evidence (Rule 11)", rule: "A.M. No. 01-7-01-SC, Rule 11" },
        { topic: "Rule on Electronic Evidence: Electronic Documents as Functional Equivalent of Original (Rule 4)", rule: "A.M. No. 01-7-01-SC, Rule 4" }
      ],
      "body-worn": [
        { topic: "Rules on Body-Worn Cameras: Mandatory Use in Execution of Search & Arrest Warrants", rule: "A.M. No. 21-06-08-SC" },
        { topic: "Rules on Body-Worn Cameras: Effect of Failure to Use or Activate Camera", rule: "A.M. No. 21-06-08-SC" },
        { topic: "Rules on Body-Worn Cameras: Chain of Custody & Admissibility of Recordings", rule: "A.M. No. 21-06-08-SC" }
      ],
      "judicial affidavit": [
        { topic: "Judicial Affidavit Rule: Scope, Application and Mandatory Submission (Sec. 2-3)", rule: "A.M. No. 12-8-8-SC, Sec. 2-3" },
        { topic: "Judicial Affidavit Rule: Content, Attestation Clause and Jurat Requirements (Sec. 3-4)", rule: "A.M. No. 12-8-8-SC, Sec. 3-4" },
        { topic: "Judicial Affidavit Rule: Offer, Objections and Cross-Examination of Affiant (Sec. 6-7)", rule: "A.M. No. 12-8-8-SC, Sec. 6-7" },
        { topic: "Judicial Affidavit Rule: Effect of Non-Compliance, Failure to Submit and Excusable Delay (Sec. 9-10)", rule: "A.M. No. 12-8-8-SC, Sec. 9-10" }
      ],
   "hague": [
        { topic: "1970 Hague Evidence Convention: Scope & Purpose of Letters of Request (Sec. 1-4)", rule: "A.M. No. 25-02-17-SC, Sec. 1-4" },
        { topic: "1970 Hague Evidence Convention: Central Authority & Transmittal Channels (Sec. 5-8)", rule: "A.M. No. 25-02-17-SC, Sec. 5-8" },
        { topic: "1970 Hague Evidence Convention: Requisites of Letter of Request & Model Form (Sec. 9-12)", rule: "A.M. No. 25-02-17-SC, Sec. 9-12" },
        { topic: "1970 Hague Evidence Convention: Execution of Request & Competent Judicial Authorities (Sec. 13-16)", rule: "A.M. No. 25-02-17-SC, Sec. 13-16" },
        { topic: "1970 Hague Evidence Convention: Compulsory Measures & Privileges from Testifying (Sec. 17-20)", rule: "A.M. No. 25-02-17-SC, Sec. 17-20" },
        { topic: "1970 Hague Evidence Convention: Pre-Trial Discovery of Documents Limitations (Sec. 21-25)", rule: "A.M. No. 25-02-17-SC, Sec. 21-25" },
        { topic: "1970 Hague Evidence Convention: Taking of Evidence by Diplomatic Officers, Consular Agents & Commissioners (Sec. 26-30)", rule: "A.M. No. 25-02-17-SC, Sec. 26-30" },
        { topic: "1970 Hague Evidence Convention: Refusal, Costs, Reimbursement & Effectivity (Sec. 31-36)", rule: "A.M. No. 25-02-17-SC, Sec. 31-36" }
      ],
      "rape shield": [
        { topic: "Rape Shield Rule: Inadmissibility of Complainant's Past Sexual Conduct / Reputation", rule: "Rule 130, Sec. 54 & Special Penal Laws" },
        { topic: "Rape Shield Rule: Recognized Exceptions & Foundational Inquiry", rule: "Supreme Court Jurisprudence" }
      ]
    };

    const DETERMINISTIC_SUB_PROVISIONS = {
      "3": [

        { subTopic: "Original Document Rule: General Rule & Meaning of Original", rule: "Rule 130, Section 3 & 4" },
        { subTopic: "Original Document Rule: Statutory Exceptions (Lost, Custody of Adverse Party, Numerous Accounts, Public Record)", rule: "Rule 130, Section 3(a)-(e)" }
      ],
      "10": [
        { subTopic: "Parol Evidence Rule: General Rule & Integrated Written Agreement", rule: "Rule 130, Section 10" },
        { subTopic: "Parol Evidence Rule: 4 Statutory Exceptions (Intrinsic Ambiguity, Failure to Express True Intent, Validity, Subsequent Agreements)", rule: "Rule 130, Section 10(a)-(d)" }
      ],
      "23": [
        { subTopic: "Marital Disqualification (Spousal Immunity): Requisites & Exceptions", rule: "Rule 130, Section 23" },
        { subTopic: "Distinction: Marital Disqualification (Sec. 23) vs. Marital Privilege (Sec. 24[a])", rule: "Rule 130, Section 23 vs. 24(a)" }
      ],
      "24": [
        { subTopic: "Marital Privileged Communication: Disqualification & Scope", rule: "Rule 130, Section 24(a)" },
        { subTopic: "Attorney-Client Privilege: Scope, Confidentiality & Crime-Fraud Exception", rule: "Rule 130, Section 24(b)" },
        { subTopic: "Physician-Patient & Psychotherapist-Patient Privilege: Civil Actions & Confidential Communication", rule: "Rule 130, Section 24(c)" },
        { subTopic: "Priest-Penitent Privilege: Confessional Seal & Spiritual Advice", rule: "Rule 130, Section 24(d)" },
        { subTopic: "Public Officer / State Secrets Privilege: Public Interest Standard", rule: "Rule 130, Section 24(e)" }
      ],
      "25": [
        { subTopic: "Parental and Filial Privilege: Rule & Statutory Exception in Criminal Cases", rule: "Rule 130, Section 25" }
      ],
      "26": [
        { subTopic: "Privilege Relating to Trade Secrets: Qualified Nature & Judicial Safeguards", rule: "Rule 130, Section 26" }
      ],
      "28": [
        { subTopic: "Offer of Compromise in Civil Cases: Inadmissibility & Exceptions", rule: "Rule 130, Section 28" },
        { subTopic: "Offer of Compromise in Criminal Cases, Quasi-Offenses & Good Samaritan Rule", rule: "Rule 130, Section 28" }
      ],
      "29": [
        { subTopic: "Res Inter Alios Acta Rule (First Branch): Admissions by Third Party", rule: "Rule 130, Section 29" }
      ],
      "30": [
        { subTopic: "Admission by Co-Partner or Agent: Requisites for Admissibility", rule: "Rule 130, Section 30" }
      ],
      "31": [
        { subTopic: "Admission by Conspirator: Requisites for Admissibility", rule: "Rule 130, Section 31" },
        { subTopic: "Admission by Conspirator: Extrajudicial Confession After Conspiracy Has Ceased", rule: "Rule 130, Section 31" }
      ],
      "33": [
        { subTopic: "Admission by Silence: Requisites for Adoptive / Implied Admission", rule: "Rule 130, Section 33" }
      ],
      "35": [
        { subTopic: "Similar Acts as Evidence (Second Branch of Res Inter Alios Acta / Propensity Rule): General Inadmissibility", rule: "Rule 130, Section 35" },
        { subTopic: "Similar Acts as Evidence: Admissible Purposes (Knowledge, Intent, Plan, System, Habit)", rule: "Rule 130, Section 35" }
      ],
      "37": [
        { subTopic: "Hearsay Rule: Definition, Exclusionary Rule & Prior Non-Hearsay Statements", rule: "Rule 130, Section 37" },
        { subTopic: "Independently Relevant Statements: Concept, Purpose & Non-Hearsay Character", rule: "Rule 130, Section 37" }
      ],
      "44": [
        { subTopic: "Part of the Res Gestae: Spontaneous Statements (Requisites & Startling Occurrence)", rule: "Rule 130, Section 44(1)" },
        { subTopic: "Part of the Res Gestae: Statements Accompanying Equivocal Acts (Verbal Acts)", rule: "Rule 130, Section 44(2)" }
      ]
    };

    const EVIDENCE_2019_CONCORDANCE = {
      "original document": { rule: "Rule 130", section: "Section 3", name: "Original Document Rule", note: "Formerly Best Evidence Rule; expanded to include electronic data and duplicates (Sec. 4)." },
      "best evidence": { rule: "Rule 130", section: "Section 3", name: "Original Document Rule", note: "Renamed from Best Evidence Rule under 2019 Amendments." },
      "parol evidence": { rule: "Rule 130", section: "Section 10", name: "Parol Evidence Rule", note: "Shifted from Sec. 9 to Sec. 10 under 2019 Amendments." },
      "marital disqualification": { rule: "Rule 130", section: "Section 23", name: "Disqualification by Reason of Marriage", note: "Shifted from Sec. 22 to Sec. 23 under 2019 Amendments." },
      "privileged communication": { rule: "Rule 130", section: "Section 24", name: "Disqualification by Reason of Privileged Communication", note: "Expanded under 2019 Amendments to include psychotherapists and persons reasonably believed to be attorneys." },
      "parental and filial": { rule: "Rule 130", section: "Section 25", name: "Parental and Filial Privilege", note: "Added exception when indispensable in crime against descendant/other parent." },
      "trade secrets": { rule: "Rule 130", section: "Section 26", name: "Privilege Relating to Trade Secrets", note: "New provision inserted under 2019 Amendments." },
      "offer of compromise": { rule: "Rule 130", section: "Section 28", name: "Offer of Compromise Not Admissible", note: "Shifted from Sec. 27 to Sec. 28 under 2019 Amendments." },
      "res inter alios": { rule: "Rule 130", section: "Section 29", name: "Admission by Third Party (Res Inter Alios Acta)", note: "Shifted from Sec. 28 to Sec. 29 under 2019 Amendments." },
      "conspirator": { rule: "Rule 130", section: "Section 31", name: "Admission by Conspirator", note: "Shifted from Sec. 30 to Sec. 31 under 2019 Amendments." },
      "privies": { rule: "Rule 130", section: "Section 32", name: "Admission by Privies", note: "Shifted from Sec. 31 to Sec. 32 under 2019 Amendments." },
      "admission by silence": { rule: "Rule 130", section: "Section 33", name: "Admission by Silence", note: "Shifted from Sec. 32 to Sec. 33 under 2019 Amendments." },
      "confession": { rule: "Rule 130", section: "Section 34", name: "Confession", note: "Shifted from Sec. 33 to Sec. 34 under 2019 Amendments." },
      "similar acts": { rule: "Rule 130", section: "Section 35", name: "Similar Acts as Evidence", note: "Shifted from Sec. 34 to Sec. 35 under 2019 Amendments." },
      "hearsay": { rule: "Rule 130", section: "Section 37", name: "Hearsay (Definition & Exclusionary Rule)", note: "General rule of inadmissibility; defines out-of-court statements and non-hearsay prior statements." },
      "independently relevant": { rule: "Rule 130", section: "Section 37", name: "Independently Relevant Statements", note: "Non-hearsay concept; statements offered to prove the fact of utterance or state of mind, not truth." },
      "dying declaration": { rule: "Rule 130", section: "Section 38", name: "Dying Declaration", note: "Shifted from Sec. 37 to Sec. 38 under 2019 Amendments." },
      "dead man's statute": { rule: "Rule 130", section: "Section 39", name: "Statement of Decedent or Person of Unsound Mind", note: "Converted from old Sec. 23 witness disqualification into Sec. 39 Hearsay Exception." },
      "statement of decedent": { rule: "Rule 130", section: "Section 39", name: "Statement of Decedent or Person of Unsound Mind", note: "Replaces old Dead Man's Statute." },
      "declaration against interest": { rule: "Rule 130", section: "Section 40", name: "Declaration Against Interest", note: "Shifted from Sec. 38 to Sec. 40 under 2019 Amendments." },
      "pedigree": { rule: "Rule 130", section: "Section 41", name: "Act or Declaration About Pedigree", note: "Shifted from Sec. 39 to Sec. 41 under 2019 Amendments." },
      "family reputation": { rule: "Rule 130", section: "Section 42", name: "Family Reputation or Tradition Regarding Pedigree", note: "Shifted from Sec. 40 to Sec. 42 under 2019 Amendments." },
      "common reputation": { rule: "Rule 130", section: "Section 43", name: "Common Reputation", note: "Shifted from Sec. 41 to Sec. 43 under 2019 Amendments." },
      "res gestae": { rule: "Rule 130", section: "Section 44", name: "Part of the Res Gestae", note: "Shifted from Sec. 42 to Sec. 44 under 2019 Amendments." },
      "startling occurrence": { rule: "Rule 130", section: "Section 44", name: "Part of the Res Gestae (Spontaneous Statements)", note: "Governed by Rule 130, Sec. 44 under 2019 Amendments." },
      "verbal acts": { rule: "Rule 130", section: "Section 44", name: "Part of the Res Gestae (Verbal Acts)", note: "Statements accompanying an equivocal act material to the issue (Rule 130, Sec. 44)." },
      "business records": { rule: "Rule 130", section: "Section 45", name: "Records of Regularly Conducted Business Activity", note: "Shifted from Sec. 43 to Sec. 45 under 2019 Amendments." },
      "regularly conducted business": { rule: "Rule 130", section: "Section 45", name: "Records of Regularly Conducted Business Activity", note: "Shifted from Sec. 43 to Sec. 45 under 2019 Amendments." },
      "official records": { rule: "Rule 130", section: "Section 46", name: "Entries in Official Records", note: "Shifted from Sec. 44 to Sec. 46 under 2019 Amendments." },
      "commercial lists": { rule: "Rule 130", section: "Section 47", name: "Commercial Lists and the Like", note: "Shifted from Sec. 45 to Sec. 47 under 2019 Amendments." },
      "learned treatises": { rule: "Rule 130", section: "Section 48", name: "Learned Treatises", note: "Shifted from Sec. 46 to Sec. 48 under 2019 Amendments." },
      "former proceeding": { rule: "Rule 130", section: "Section 49", name: "Testimony or Deposition at a Former Proceeding", note: "Shifted from Sec. 47 to Sec. 49 under 2019 Amendments." },
      "residual exception": { rule: "Rule 130", section: "Section 50", name: "Residual Exception", note: "Catch-all hearsay exception introduced in 2019 Amendments." },
      "character evidence": { rule: "Rule 130", section: "Section 54", name: "Character Evidence Not Generally Admissible", note: "Shifted from Sec. 51 to Sec. 54 under 2019 Amendments." }
    };

    // ---------------------------------------------------------------------------
    // UNIFIED SINGLE INDEXED-DB STORAGE ENGINE (WITH SUBJECT TAGGING)
    // ---------------------------------------------------------------------------
    function openDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const dbInstance = e.target.result;
          if (!dbInstance.objectStoreNames.contains('sources')) dbInstance.createObjectStore('sources', { keyPath: 'id' });
          if (!dbInstance.objectStoreNames.contains('digests')) dbInstance.createObjectStore('digests', { keyPath: 'id' });
          if (!dbInstance.objectStoreNames.contains('metadata')) dbInstance.createObjectStore('metadata', { keyPath: 'key' });
          if (!dbInstance.objectStoreNames.contains('mastery')) dbInstance.createObjectStore('mastery', { keyPath: 'id' });
          if (!dbInstance.objectStoreNames.contains('decks')) dbInstance.createObjectStore('decks', { keyPath: 'id' });
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e);
      });
    }

    async function dbSave(store, item) {
      if (!item.subject) item.subject = currentSubjectName;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e);
      });
    }

    async function dbGetAllRaw(store) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e);
      });
    }

    async function dbGetAll(store) {
      const all = await dbGetAllRaw(store);
      return all.filter(item => !item.subject || item.subject === currentSubjectName);
    }

    async function dbGet(store, key) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e);
      });
    }

    async function dbDelete(store, id) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e);
      });
    }

    async function dbClearSubjectStore(store) {
      const subjectItems = await dbGetAll(store);
      for (const item of subjectItems) {
        const keyVal = store === 'metadata' ? item.key : item.id;
        if (keyVal) await dbDelete(store, keyVal);
      }
    }

    function metaKey(k) {
      return `${currentSubjectName}::${k}`;
    }

    function masteryKey(topic) {
      return `${currentSubjectName}::${topic.trim()}`;
    }

    // ---------------------------------------------------------------------------
    // TEXT NORMALIZATION, PHONETIC & DOCKET UTILITIES
    // ---------------------------------------------------------------------------
    function shuffleArray(arr) {
      const array = [...arr];
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
      return array;
    }

    function escapeHtml(str) {
      return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function normalizeDiacritics(str) {
      return (str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ñ/gi, 'n')
        .toLowerCase();
    }

    function normalizePhoneticToken(token) {
      let t = normalizeDiacritics(token).replace(/[^a-z0-9]/g, '');
      const ALIASES = {
        'norodin': 'norrudin',
        'nurrudin': 'norrudin',
        'nurodin': 'norrudin',
        'inopiguez': 'inopiquez',
        'delaseras': 'eras',
        'laseras': 'eras'
      };
      return ALIASES[t] || t.replace(/([a-z])\1+/g, '$1');
    }

    function stripMaternalSurname(title) {
      return (title || '').replace(/\s+y\s+[A-Za-z\u00C0-\u017F-]+/gi, '');
    }

    function cleanAlphanumeric(str) {
      return normalizeDiacritics(stripMaternalSurname(str)).replace(/[^a-z0-9]/g, '');
    }

    const PH_ACRONYM_MAP = {
      'bpi': 'bank of the philippine islands',
      'pnb': 'philippine national bank',
      'pnoc': 'philippine national oil company',
      'comelec': 'commission on elections',
      'dar': 'department of agrarian reform',
      'denr': 'department of environment and natural resources',
      'ibp': 'integrated bar of the philippines',
      'cir': 'commissioner of internal revenue',
      'ca': 'court of appeals',
      'sc': 'supreme court',
      'dbp': 'development bank of the philippines',
      'gsis': 'government service insurance system',
      'sss': 'social security system',
      'nlrc': 'national labor relations commission',
      'sec': 'securities and exchange commission'
    };

    function expandAcronyms(str) {
      let lower = normalizeDiacritics(str);
      for (const [acro, full] of Object.entries(PH_ACRONYM_MAP)) {
        const regex = new RegExp(`\\b${acro}\\b`, 'g');
        lower = lower.replace(regex, `${acro} ${full}`);
      }
      return lower;
    }

    function extractDocketId(str) {
      if (!str) return null;
      const m = str.match(/\b(?:G\.R\.|A\.M\.|A\.C\.|B\.M\.|UDK)\s*(?:Nos?\.)?\s*(?:L-)?([A-Za-z0-9-]*?[0-9]{4,8}[A-Za-z0-9-]*)/i);
      if (m && m[1]) {
        return m[1].toUpperCase().replace(/^L-/, '').replace(/[.,;]+$/, '');
      }
      const amMatch = str.match(/\bA\.M\.\s*(?:No\.)?\s*([A-Z]{2,4}-\d{2}-\d{3,6})/i);
      if (amMatch && amMatch[1]) return amMatch[1].toUpperCase();
      const lMatch = str.match(/\bL-([0-9]{4,8})\b/i);
      if (lMatch && lMatch[1]) return lMatch[1];
      return null;
    }

    function extractSectionNumberToken(str) {
      if (!str) return null;
      const m = str.match(/\b(?:Section|Sec\.)\s*(\d{1,3})\b/i);
      return m ? m[1] : null;
    }

    function extractRuleNumberToken(str) {
      if (!str) return null;
      const m = str.match(/\bRule\s*(\d{1,3})\b/i);
      return m ? m[1] : null;
    }

    function sanitizeCitation(text) {
      if (!text) return text;
      let lower = text.toLowerCase();
      for (const [key, val] of Object.entries(EVIDENCE_2019_CONCORDANCE)) {
        if (lower.includes(key)) {
          if (lower.includes(' v. ') || lower.includes(' vs. ') || lower.includes('in re')) {
            return `${text.trim()} · ${val.rule}, ${val.section}`;
          }
          return `${val.name} (${val.rule}, ${val.section})`;
        }
      }
      return text.trim();
    }

    function sanitizeQuestionPrompt(text) {
      if (!text) return '';
      return text
        .replace(/\[\s*Active Recall Cloze Enhanced:[^\]]*\]/gi, '')
        .replace(/\(\s*Active Recall Cloze Enhanced:[^\)]*\)/gi, '')
        .replace(/\[\s*(?:Note|Instruction|Directive|Prompt Tag):[^\]]*\]/gi, '')
        .replace(/---\s*MASHED ADDITION\s*---/gi, '\n\n')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
    }

    function checkConcordanceNote(topicText) {
      if (!topicText) return null;
      let lower = topicText.toLowerCase();
      for (const [key, val] of Object.entries(EVIDENCE_2019_CONCORDANCE)) {
        if (lower.includes(key)) {
          return `${val.name} is governed strictly by ${val.rule}, ${val.section}. ${val.note}`;
        }
      }
      const secNum = extractSectionNumberToken(topicText);
      const ruleNum = extractRuleNumberToken(topicText) || "130";
      const canonical = secNum ? CANONICAL_2019_CODAL_MAP[`${ruleNum}:${secNum}`] : null;
      if (canonical) {
        return `Rule ${ruleNum}, Section ${secNum} (${canonical.title}) — Verbatim Statutory Anchor Active.`;
      }
      return null;
    }

    // ---------------------------------------------------------------------------
    // STATUTORY & ALAC HEALING + UNIFIED FILE EXPORT UTILITIES
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // STATUTORY & ALAC HEALING + UNIFIED FILE EXPORT UTILITIES
    // ---------------------------------------------------------------------------
    function healTruncatedStatutoryText(text, topic) {
      if (!text || text.trim().endsWith(':') || text.trim().endsWith('-') || text.length < 40) {
        const canonical = retrieveVerbatimProvision(topic);
        if (canonical && canonical.length > (text ? text.length : 0)) return canonical;
      }
      return text || '';
    }

    function healTruncatedAlacBasis(basis, fallback) {
      if (!basis || basis.length < 30) {
        return fallback || basis || '';
      }
      return basis;
    }

    async function exportWithSaveDialog(content, defaultFilename, mimeType = 'text/plain', fileDescription = 'File', extension = '') {
      if (window.__TAURI__?.dialog && window.__TAURI__?.fs) {
        try {
          const filePath = await window.__TAURI__.dialog.save({
            defaultPath: defaultFilename,
            filters: extension ? [{ name: fileDescription, extensions: [extension.replace(/^\./, '')] }] : []
          });
          if (filePath) {
            await window.__TAURI__.fs.writeTextFile(filePath, content);
            return true;
          }
          return false;
        } catch (err) {
          console.warn("Tauri native save failed, using browser download fallback:", err);
        }
      }

      const file = new File([content], defaultFilename, { type: mimeType || 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: defaultFilename });
          return true;
        } catch (err) {
          console.warn("Native share failed, falling back:", err);
        }
      }

      const blob = new Blob([content], { type: mimeType || 'application/json' });
      try {
        const shareFile = new File([blob], defaultFilename, { type: mimeType || 'application/json' });
        if (navigator.canShare && navigator.share && navigator.canShare({ files: [shareFile] })) {
          await navigator.share({ files: [shareFile], title: defaultFilename });
          return true;
        }
      } catch (shareErr) {
        if (shareErr && shareErr.name === 'AbortError') return false;
      }

      if (/Android|wv/i.test(navigator.userAgent) || window.location.protocol === 'file:') {
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const a = document.createElement('a');
            a.href = reader.result;
            a.download = defaultFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            resolve(true);
          };
          reader.onerror = () => resolve(false);
          reader.readAsDataURL(blob);
        });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }

    // ---------------------------------------------------------------------------
    // HIGH-LEGIBILITY MICRO-FORMATTER FOR BENCHMARK BREAKDOWNS
    // ---------------------------------------------------------------------------
    function detectEnumerationFamily(para) {
      const combined = '\\((?:[1-9]|10|[a-h]|i|ii|iii|iv|v)\\)';
      if (/\(1\)\s+/.test(para) && /\(2\)\s+/.test(para)) return combined;
      if (/\(a\)\s+/i.test(para) && /\(b\)\s+/i.test(para)) return combined;
      if (/\(i\)\s+/i.test(para) && /\(ii\)\s+/i.test(para)) return combined;
      if (/^\((?:[1-9]|10|[a-h]|i|ii|iii|iv|v)\)\s+/i.test(para.trim())) return combined;
      return null;
    }

    function formatBenchmarkText(rawText, highlightLead = false) {
      if (!rawText || !rawText.trim()) {
        return '<span class="text-slate-500 italic">No text extracted for this section.</span>';
      }

      let text = rawText
        .replace(/\r\n/g, '\n')
        .replace(/\[Page\s+\d+\]/gi, ' ')
        .replace(/###\s*Page\s+\d+\s*/gi, ' ')
        .replace(/\[SOURCE EXCERPT - [^\]]+\]:\s*/gi, '')
        .replace(/\[Excerpt Truncated\]/gi, '...')
        .replace(/\[VERBATIM SECTION:[^\]]*\]/gi, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();

      // PHASE 4: PRE-PARSE CLOZE DELETIONS {{c1::phrase::hint}} -> SAFE TOKENS
      text = text.replace(/\{\{c(\d+)::(.*?)(?:::([^}]+))?\}\}/g, (match, cNum, answer, hint) => {
        const hintPart = hint ? `::${hint.trim()}` : '';
        return `§§CLOZE_${cNum}_${answer.trim()}${hintPart}§§`;
      });

      text = text.replace(/(\d{4}[A-Za-z0-9,.\s]*?)\s+(?:■\s*)?(Doctrine|Facts|Issues?|Ruling)\b/gi, '$1\n\n$2: ');

      text = text.replace(
        /([.?!;]"?)\s+(?=(?:'|“|"|■\s*)?(?:On\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)|In\s+(?:the\s+morning|the\s+evening|the\s+early|\d{4})|At\s+(?:around|approximately)|Shortly\s+thereafter|Meanwhile|Subsequently|Consequently|Aggrieved|Dissatisfied|For\s+(?:his|her|their)\s+(?:part|defense)|In\s+(?:his|her|their)\s+defense|During\s+(?:the\s+)?(?:trial|cross-examination)|The\s+(?:identification|mere\s+fact|court|first|second|word|rule|prosecution|defense)|Appellant,?\s+therefore|Section\s+\d+|Sec\.\s+\d+|Article\s+\d+|Art\.\s+\d+|Rule\s+\d+|Provided,\s+however|Provided,\s+that|Unfortunately|Declarations?\s+as\s+to|Parenthetically|In\s+sum,|In\s+fine,|All\s+told,|However,|Moreover,|Furthermore,|On\s+the\s+other\s+hand,|In\s+contrast,|Conversely,|First[.,]|Second[.,]|Third[.,]|Fourth[.,]|A\.\s+Statutory|B\.\s+Jurisprudential|WHEREFORE|ACCORDINGLY)\b)/gi,
        '$1\n\n'
      );

      const rawParas = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
      const segmentedParas = [];

      for (const p of rawParas) {
        if (p.length > 420 && !/\((?:[1-9]|10|[a-h]|i|ii)\)/i.test(p)) {
          const sentences = p.match(/[^.?!]+[.?!]+["”']?(?:\s+|$)/g);
          if (sentences && sentences.length > 2) {
            let chunk = '';
            for (let i = 0; i < sentences.length; i++) {
              chunk += sentences[i];
              if ((i + 1) % 2 === 0 || i === sentences.length - 1) {
                segmentedParas.push(chunk.trim());
                chunk = '';
              }
            }
            if (chunk.trim()) segmentedParas.push(chunk.trim());
            continue;
          }
        }
        segmentedParas.push(p);
      }

      const finalHtml = [];

      function applyLeadBadges(escapedStr) {
        return escapedStr.replace(
          /^(YES|NO|ADMISSIBLE|INADMISSIBLE|SUSTAINED|OVERRULED|AFFIRMED|REVERSED|GRANTED|DENIED|VALID|INVALID|TENABLE|UNTENABLE|GENERAL RULE)(\b[,.:;\s]*)/i,
          (match, word, sep) => {
            const isNeg = /^(?:NO|INADMISSIBLE|SUSTAINED|REVERSED|DENIED|INVALID|UNTENABLE)$/i.test(word);
            const badgeClass = isNeg
              ? 'bg-red-950 text-red-300 border-red-700'
              : 'bg-emerald-950 text-emerald-300 border-emerald-700';
            return `<span class="inline-block px-2.5 py-0.5 mr-1.5 rounded text-xs font-mono font-bold border ${badgeClass}">${word.toUpperCase()}</span>${sep}`;
          }
        );
      }

      for (let idx = 0; idx < segmentedParas.length; idx++) {
        const para = segmentedParas[idx];
        const family = detectEnumerationFamily(para);

        if (family) {
          const splitRegex = new RegExp(`(?=(?:^|\\s+)${family}\\s+)`, 'i');
          const segments = para.split(splitRegex).map(s => s.trim()).filter(Boolean);

          for (const seg of segments) {
            const itemMatch = seg.match(new RegExp(`^(${family})\\s*(.*)`, 'is'));
            if (itemMatch) {
              const marker = itemMatch[1];
              let content = itemMatch[2].trim();
              let detachedCommentary = '';

              const boundaryMatch = content.match(/^.*?[.?!](?:\n+|\s+[A-Z][^.?!]{20,})/s);
              if (boundaryMatch) {
                const splitIdx = boundaryMatch[0].length;
                const trailingText = content.substring(splitIdx).trim();
                if (trailingText) {
                  detachedCommentary = trailingText;
                  content = content.substring(0, splitIdx).trim();
                }
              }

              finalHtml.push(
                `<div class="my-1.5 pl-3 border-l-2 border-amber-500/50 flex items-start space-x-2">` +
                  `<span class="text-amber-400 font-mono font-bold text-xs shrink-0 mt-0.5">${escapeHtml(marker)}</span>` +
                  `<span class="text-slate-200 leading-relaxed">${escapeHtml(content)}</span>` +
                `</div>`
              );

              if (detachedCommentary) {
                finalHtml.push(`<p class="leading-relaxed mb-2 mt-2">${escapeHtml(detachedCommentary)}</p>`);
              }
            } else {
              let escaped = escapeHtml(seg);
              if (highlightLead && idx === 0 && finalHtml.length === 0) {
                escaped = applyLeadBadges(escaped);
              }
              escaped = escaped.replace(
                /^((?:Rule|Section|Sec\.|Article|Art\.)\s+\d+[A-Za-z0-9().-]*\s*[.—:-]?)/i,
                '<span class="text-amber-300 font-mono font-bold">$1</span>'
              );
              finalHtml.push(`<p class="leading-relaxed mb-2">${escaped}</p>`);
            }
          }
        } else {
          let escaped = escapeHtml(para);
          if (highlightLead && idx === 0) {
            escaped = applyLeadBadges(escaped);
          }
          escaped = escaped.replace(
            /^((?:Rule|Section|Sec\.|Article|Art\.)\s+\d+[A-Za-z0-9().-]*\s*[.—:-]?)/i,
            '<span class="text-amber-300 font-mono font-bold">$1</span>'
          );

          // PHASE 4: RENDER CLOZE BADGES WITH OPTIONAL HINT
          escaped = escaped.replace(/§§CLOZE_(\d+)_(.*?)(?:::([^§]+))?§§/g, (m, cNum, answer, hint) => {
            const hintHtml = hint ? `<span class="text-[10px] text-amber-400 font-mono italic ml-1">(${hint})</span>` : '';
            return `<span class="inline-flex items-center px-2 py-0.5 mx-0.5 rounded bg-amber-950/80 border border-amber-600/70 text-amber-200 font-mono text-xs font-semibold shadow-sm" title="Cloze [c${cNum}]"><span class="text-amber-500 font-bold mr-1">c${cNum}:</span>${answer}${hintHtml}</span>`;
          });

          if (/^(?:Q:|A:|Court:|WITNESS:|FISCAL:)/i.test(escaped)) {
            finalHtml.push(`<div class="pl-3 py-1 border-l-2 border-slate-700 text-slate-300 font-mono text-xs">${escaped}</div>`);
          } else {
            finalHtml.push(`<p class="leading-relaxed mb-2">${escaped}</p>`);
          }
        }
      }

      return finalHtml.join('');
    }

    // ---------------------------------------------------------------------------
    // APPLICATION STATE MACHINE & TRI-STATE HYBRID GATEKEEPER
    // ---------------------------------------------------------------------------
    const state = {
      studyMode: 'AI_EXAM',
      operatingPipeline: 'BLOCKED',
      isSessionActive: false,
      benchmarkLargeFont: false,
      activePreset: 'ALL',
      activeDimensions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      apiKeys: [],
      currentKeyIndex: 0,
      selectedModel: localStorage.getItem('bar_gemini_model_universal_v14') || 'gemini-3.8-flash',
      syllabusFileName: '',
      extractedSyllabusText: '',
      loadedFiles: [],
      parsedDigests: [],
      allUnbundledPool: [],
      batchedSets: [],
      activeBatchIdx: 0,
      activeAgenda: [],
      currentQuestionIndex: 0,
      totalQuestions: 15,
      currentQuestionText: '',
      activeTopicName: '',
      activeCardItem: null,
      timerSeconds: 180,
      timerDefault: 180,
      timerInterval: null,
      timerRunning: false,
      isAssisted: false,
      currentBenchmarkPayload: null,
      prefetchedNextQuestion: null,
      prefetchPromise: null,
      sessionTranscript: [],
      activeDeckCardsPool: [],
      activeDeckTitle: ''
    };

    let inMemoryChunks = [];

    function evaluateGatekeeperState() {
      const hasSources = state.loadedFiles && state.loadedFiles.length > 0;
      const hasSyllabus = Boolean(state.extractedSyllabusText && state.extractedSyllabusText.trim().length > 0);
      const scopeVal = document.getElementById('typedScopeInput')?.value.trim() || '';
      const hasScope = scopeVal.length > 0;

      const banner = document.getElementById('gatekeeperBanner');
      const dot = document.getElementById('gatekeeperDot');
      const title = document.getElementById('gatekeeperModeTitle');
      const statusText = document.getElementById('gatekeeperStatusText');
      const pill = document.getElementById('gatekeeperPill');
      const topBadge = document.getElementById('operatingModeBadge');
      const footerLaunchBtn = document.getElementById('footerLaunchBtn');
      const footerPreCompileBtn = document.getElementById('footerPreCompileBtn');
      const preCompileScopeBtn = document.getElementById('preCompileScopeBtn');

      if (!hasSources && !hasSyllabus) {
        state.operatingPipeline = 'BLOCKED';
        if (banner) banner.className = "p-3.5 rounded-xl border border-red-800/80 bg-red-950/30 flex items-start justify-between gap-3 transition";
        if (dot) dot.className = "inline-block w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse";
        if (title) {
          title.className = "text-xs font-mono uppercase font-bold text-red-300";
          title.innerText = "GATEKEEPER BLOCKED: NO SYLLABUS OR REFERENCE SOURCES UPLOADED";
        }
        if (statusText) {
          statusText.innerHTML = "Execution blocked. Please attach a <b>Course Syllabus (Anchor 1)</b> OR upload <b>Reference Sources (Anchor 2)</b>—or both—and specify your <b>Coverage Scope</b>.";
        }
        if (pill) {
          pill.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-950 text-red-300 border border-red-800 shrink-0";
          pill.innerText = "LOCKED";
        }
        if (topBadge) {
          topBadge.className = "text-[10px] uppercase font-mono tracking-wider bg-red-950/90 text-red-300 px-2 py-0.5 rounded border border-red-800 font-semibold";
          topBadge.innerText = "Blocked: Attach Syllabus or Sources";
        }
        if (footerLaunchBtn) footerLaunchBtn.disabled = true;
        if (footerPreCompileBtn) footerPreCompileBtn.disabled = true;
        if (preCompileScopeBtn) preCompileScopeBtn.disabled = true;
        return false;
      }

      if (!hasScope) {
        state.operatingPipeline = 'BLOCKED';
        if (banner) banner.className = "p-3.5 rounded-xl border border-amber-700/80 bg-amber-950/30 flex items-start justify-between gap-3 transition";
        if (dot) dot.className = "inline-block w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse";
        if (title) {
          title.className = "text-xs font-mono uppercase font-bold text-amber-300";
          title.innerText = "ANCHORS DETECTED — AWAITING TARGET COVERAGE SCOPE";
        }
        if (statusText) {
          statusText.innerHTML = `You have loaded ${hasSyllabus && hasSources ? 'both a Syllabus and Reference Sources' : (hasSyllabus ? 'a Course Syllabus' : 'Reference Sources')}. Now enter the specific module, section range, or case list in the <b>Target Coverage Scope</b> box below to unlock launch.`;
        }
        if (pill) {
          pill.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950 text-amber-300 border border-amber-800 shrink-0";
          pill.innerText = "ENTER SCOPE";
        }
        if (topBadge) {
          topBadge.className = "text-[10px] uppercase font-mono tracking-wider bg-amber-950 text-amber-300 px-2 py-0.5 rounded border border-amber-800 font-semibold";
          topBadge.innerText = "Awaiting Coverage Scope";
        }
        if (footerLaunchBtn) footerLaunchBtn.disabled = true;
        if (footerPreCompileBtn) footerPreCompileBtn.disabled = true;
        if (preCompileScopeBtn) preCompileScopeBtn.disabled = true;
        return false;
      }

      if (footerLaunchBtn) footerLaunchBtn.disabled = false;
      if (footerPreCompileBtn) footerPreCompileBtn.disabled = false;
      if (preCompileScopeBtn) preCompileScopeBtn.disabled = false;

      if (hasSyllabus && hasSources) {
        state.operatingPipeline = 'HYBRID_GOLD';
        if (banner) banner.className = "p-3.5 rounded-xl border border-emerald-700/80 bg-emerald-950/30 flex items-start justify-between gap-3 transition";
        if (dot) dot.className = "inline-block w-2.5 h-2.5 rounded-full bg-emerald-400";
        if (title) {
          title.className = "text-xs font-mono uppercase font-bold text-emerald-300";
          title.innerText = "★ HYBRID GOLD MODE ACTIVE (SYLLABUS + REFERENCE SOURCES + SCOPE)";
        }
        if (statusText) {
          statusText.innerHTML = `Syllabus structure paired with <b>${state.loadedFiles.length} Reference File(s)</b> (${state.parsedDigests.length} Case Digests & ${inMemoryChunks.length} Statutory/Reviewer Chunks). Local matches extract in 0 ms!`;
        }
        if (pill) {
          pill.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-700 shrink-0";
          pill.innerText = "HYBRID READY";
        }
        if (topBadge) {
          topBadge.className = "text-[10px] uppercase font-mono tracking-wider bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-700 font-semibold";
          topBadge.innerText = "★ Hybrid Gold Mode (Syllabus + Sources)";
        }
      } else if (hasSources && !hasSyllabus) {
        state.operatingPipeline = 'SOURCE_ONLY';
        if (banner) banner.className = "p-3.5 rounded-xl border border-sky-700/80 bg-sky-950/30 flex items-start justify-between gap-3 transition";
        if (dot) dot.className = "inline-block w-2.5 h-2.5 rounded-full bg-sky-400";
        if (title) {
          title.className = "text-xs font-mono uppercase font-bold text-sky-300";
          title.innerText = "● SOURCE-DRIVEN MODE ACTIVE (REFERENCE SOURCES + SCOPE)";
        }
        if (statusText) {
          statusText.innerHTML = `Operating strictly on your <b>${state.loadedFiles.length} uploaded Reference File(s)</b> (${state.parsedDigests.length} Case Digests & ${inMemoryChunks.length} Chunks) filtered by your typed Coverage Scope.`;
        }
        if (pill) {
          pill.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-950 text-sky-300 border border-sky-700 shrink-0";
          pill.innerText = "SOURCE READY";
        }
        if (topBadge) {
          topBadge.className = "text-[10px] uppercase font-mono tracking-wider bg-sky-950 text-sky-300 px-2 py-0.5 rounded border border-sky-700 font-semibold";
          topBadge.innerText = "Source-Driven Mode (Sources + Scope)";
        }
      } else {
        state.operatingPipeline = 'SYLLABUS_ONLY';
        if (banner) banner.className = "p-3.5 rounded-xl border border-amber-600/80 bg-amber-950/30 flex items-start justify-between gap-3 transition";
        if (dot) dot.className = "inline-block w-2.5 h-2.5 rounded-full bg-amber-400";
        if (title) {
          title.className = "text-xs font-mono uppercase font-bold text-amber-300";
          title.innerText = "◆ SYLLABUS-DRIVEN MODE ACTIVE (SYLLABUS + SCOPE · ZERO SOURCES)";
        }
        if (statusText) {
          statusText.innerHTML = `Operating on your attached Course Syllabus (<b>${escapeHtml(state.syllabusFileName)}</b>) and specified Scope. Unbundling provisions, doctrines, and cases directly.`;
        }
        if (pill) {
          pill.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950 text-amber-300 border border-amber-700 shrink-0";
          pill.innerText = "SYLLABUS READY";
        }
        if (topBadge) {
          topBadge.className = "text-[10px] uppercase font-mono tracking-wider bg-amber-950 text-amber-300 px-2 py-0.5 rounded border border-amber-700 font-semibold";
          topBadge.innerText = "Syllabus-Driven Mode (Syllabus + Scope)";
        }
      }

      return true;
    }

    window.addEventListener('DOMContentLoaded', async () => {
      await openDB();

      // Part 4A-3: Check for an unfinished active session on boot
      try {
        const savedSessionJson = localStorage.getItem(`bar_active_session_${currentSubjectName}`);
        if (savedSessionJson) {
          const session = JSON.parse(savedSessionJson);
          if (session && session.activeAgenda && session.currentQuestionIndex <= session.totalQuestions) {
            const resumeChoice = confirm(`Found an active recitation session for ${currentSubjectName} at Card ${session.currentQuestionIndex} of ${session.totalQuestions}.\n\nWould you like to resume where you left off?`);
            if (resumeChoice) {
              state.activeAgenda = session.activeAgenda;
              state.totalQuestions = session.totalQuestions;
              state.activeBatchIdx = session.activeBatchIdx || 0;
              state.isSessionActive = true;

              document.getElementById('progressDisplay')?.classList.remove('hidden');
              document.getElementById('totalQNum').innerText = state.totalQuestions;
              document.getElementById('saveDeckHeaderBtn')?.classList.remove('hidden');

              await requestScreenWakeLock();
              await launchActiveCard(session.currentQuestionIndex);
              return; // Skip rest of fresh boot if resumed
            } else {
              localStorage.removeItem(`bar_active_session_${currentSubjectName}`);
            }
          }
        }
      } catch (err) {
        console.warn("Could not restore active session:", err);
      }

      const rawSavedKeys = localStorage.getItem('bar_gemini_api_keys') || '';
      if (rawSavedKeys) {
        document.getElementById('apiKeyInput').value = rawSavedKeys;
        parseApiKeys(rawSavedKeys);
      }

      applyModelToUI(state.selectedModel);

      const sel = document.getElementById('subjectSelector');
      if (sel) {
        let exists = false;
        for (let i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value.toLowerCase() === currentSubjectName.toLowerCase()) {
            sel.selectedIndex = i;
            exists = true;
            break;
          }
        }
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = currentSubjectName;
          opt.innerText = currentSubjectName;
          sel.insertBefore(opt, sel.options[sel.options.length - 1]);
          sel.value = currentSubjectName;
        }
      }
      const setupSel = document.getElementById('setupSubjectSelector');
      if (setupSel) {
        let exists = false;
        for (let i = 0; i < setupSel.options.length; i++) {
          if (setupSel.options[i].value.toLowerCase() === currentSubjectName.toLowerCase()) {
            setupSel.selectedIndex = i;
            exists = true;
            break;
          }
        }
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = currentSubjectName;
          opt.innerText = currentSubjectName;
          setupSel.insertBefore(opt, setupSel.options[setupSel.options.length - 1]);
          setupSel.value = currentSubjectName;
        }
      }

      const savedDims = localStorage.getItem('bar_universal_dims_' + currentSubjectName);
      const savedPreset = localStorage.getItem('bar_universal_preset_' + currentSubjectName);
      if (savedDims) {
        try {
          const parsedDims = JSON.parse(savedDims);
          if (Array.isArray(parsedDims) && parsedDims.length > 0) {
            state.activeDimensions = parsedDims;
            state.activePreset = savedPreset || 'CUSTOM';
            syncDimensionCheckboxesToState();
          }
        } catch (_) {}
      } else {
        applyDimensionPreset('ALL', true);
      }

      await refreshMasteryStatsUI();
      await renderDeckListUI();
      

      state.loadedFiles = await dbGetAll('sources');
      state.parsedDigests = await dbGetAll('digests');

      const savedSyllabus = (await dbGet('metadata', metaKey('syllabus'))) || (await dbGet('metadata', 'syllabus'));
      if (savedSyllabus && (!savedSyllabus.subject || savedSyllabus.subject === currentSubjectName)) {
        state.syllabusFileName = savedSyllabus.name;
        state.extractedSyllabusText = savedSyllabus.text;
        document.getElementById('syllabusFileStatus').innerText = `Saved: ${savedSyllabus.name}`;
        document.getElementById('clearSyllabusBtn').classList.remove('hidden');
      }

      const savedScope = (await dbGet('metadata', metaKey('typedScope'))) || (await dbGet('metadata', 'typedScope'));
      if (savedScope && (!savedScope.subject || savedScope.subject === currentSubjectName)) {
        document.getElementById('typedScopeInput').value = savedScope.text;
      }

      await buildSearchIndex();
      renderSourcesList();
      evaluateGatekeeperState();

      // Check active Google OAuth session token
      const cachedToken = sessionStorage.getItem('bar_drive_access_token');
      const cachedEmail = sessionStorage.getItem('bar_drive_user_email');
      if (cachedToken) {
        gDriveAccessToken = cachedToken;
        gDriveUserEmail = cachedEmail || 'Google Drive Connected';
        updateAuthUIState(true);
      } else {
        updateAuthUIState(false);
      }

      // Check disk sync on launch
      await checkForModernDiskSync(currentSubjectName);

// Periodic background scan every 60 seconds (pauses while drilling cards)
if (syncScanInterval) clearInterval(syncScanInterval);
      syncScanInterval = setInterval(() => {
        checkForModernDiskSync(currentSubjectName);
      }, 60000);

      // Startup modal sequence: Video tutorial takes precedence on first launch
const hasSeenVideo = localStorage.getItem('bar_has_seen_video_tutorial');
      const hasSeenTextGuide = localStorage.getItem('bar_has_seen_tutorial');

      if (!hasSeenVideo) {
        document.getElementById('videoTutorialModal')?.classList.remove('hidden');
      } else if (!hasSeenTextGuide) {
        document.getElementById('tutorialModal')?.classList.remove('hidden');
      }
    });

    // ---------------------------------------------------------------------------
    // 10-DIMENSION MATRIX & PRESET CONTROLS
    // ---------------------------------------------------------------------------
    function applyDimensionPreset(presetKey, skipPreviewRefresh = false) {
      const profile = PRESET_PROFILES[presetKey] || PRESET_PROFILES.ALL;
      state.activePreset = presetKey;
      state.activeDimensions = [...profile.dims];

      for (let i = 1; i <= 6; i++) {
        const cb = document.getElementById('dimCheck_' + i);
        if (cb) cb.checked = state.activeDimensions.includes(i);
      }

      updateDimensionPresetUI();
      localStorage.setItem('bar_universal_dims_' + currentSubjectName, JSON.stringify(state.activeDimensions));
      localStorage.setItem('bar_universal_preset_' + currentSubjectName, state.activePreset);

      if (!skipPreviewRefresh) {
        const scopeVal = document.getElementById('typedScopeInput')?.value || '';
        updateScopePreviewUI(scopeVal);
      }
    }

    function syncDimensionCheckboxesToState() {
      for (let i = 1; i <= 6; i++) {
        const cb = document.getElementById('dimCheck_' + i);
        if (cb) cb.checked = state.activeDimensions.includes(i);
      }
      updateDimensionPresetUI();
    }

    function onDimensionCheckboxChanged() {
      const checked = [];
      for (let i = 1; i <= 6; i++) {
        const cb = document.getElementById('dimCheck_' + i);
        if (cb && cb.checked) checked.push(i);
      }
      if (checked.length === 0) {
        alert("At least one recitation dimension must remain active.");
        document.getElementById('dimCheck_1').checked = true;
        checked.push(1);
      }
      state.activeDimensions = checked;

      let matchedPreset = 'CUSTOM';
      for (const [k, prof] of Object.entries(PRESET_PROFILES)) {
        if (prof.dims.length === checked.length && prof.dims.every(d => checked.includes(d))) {
          matchedPreset = k;
          break;
        }
      }
      state.activePreset = matchedPreset;
      updateDimensionPresetUI();

      localStorage.setItem('bar_universal_dims_' + currentSubjectName, JSON.stringify(state.activeDimensions));
      localStorage.setItem('bar_universal_preset_' + currentSubjectName, state.activePreset);

      const scopeVal = document.getElementById('typedScopeInput')?.value || '';
      updateScopePreviewUI(scopeVal);
    }

    function updateDimensionPresetUI() {
      const countBadge = document.getElementById('activeDimCountBadge');
      const headerLabel = document.getElementById('activePresetHeaderLabel');

      const count = state.activeDimensions.length;
      if (countBadge) countBadge.innerText = `${count} of 6 Archetypes Active`;

      const presetName = PRESET_PROFILES[state.activePreset]
        ? PRESET_PROFILES[state.activePreset].name
        : `Custom Matrix (${count}/6)`;
      if (headerLabel) headerLabel.innerText = presetName;

      ['CODAL', 'CASE', 'REVIEWER', 'ALL'].forEach(key => {
        const btn = document.getElementById('presetBtn_' + key);
        if (!btn) return;
        if (state.activePreset === key) {
          btn.className = "px-3 py-2 rounded-lg text-xs font-mono font-bold border border-emerald-500 bg-emerald-950/50 text-emerald-200 transition text-left shadow";
        } else {
          btn.className = "px-3 py-2 rounded-lg text-xs font-mono font-bold border border-slate-800 bg-slate-900 text-slate-300 hover:border-amber-500/60 transition text-left";
        }
      });
    }

    // ---------------------------------------------------------------------------
    // HARDENED CASE DIGEST PARSER (NO CROSS-CASE BLEED OR TRAILING TOPIC HEADERS)
    // ---------------------------------------------------------------------------
    function isCaseCaptionLine(line) {
      if (!line || line.length < 8 || line.length > 260) return false;
      const cleaned = line.replace(/^[■•▪♦◦*-]+\s*/, '').trim();
      if (/^[a-z]/.test(cleaned)) return false;
      if (/^(?:Doctrine|Facts|Issues?|Ruling|MODULE|Part)\b/i.test(cleaned)) return false;

      const hasVersus = /\s+(?:v\.?|vs\.?|versus)\s+/i.test(cleaned);
      const isInRe = /^(?:In\s+re\b|In\s+the\s+matter\s+of\b)/i.test(cleaned);
      const hasDocket = /\b(?:G\.R\.|A\.C\.|A\.M\.|B\.M\.|UDK|L-\d)/i.test(cleaned);

      if ((hasVersus || isInRe) && hasDocket) return true;
      if (hasVersus || isInRe) {
        const wordCount = cleaned.split(/\s+/).length;
        if (wordCount <= 24 && !/[.?!]$/.test(cleaned)) return true;
      }
      return false;
    }

    function isTrailingModuleOrTopicHeader(line) {
      if (!line) return false;
      const trimmed = line.replace(/^[■•▪♦◦*-]+\s*/, '').trim();
      if (/^(?:MODULE|Module|PART|Part)\s+\d+/i.test(trimmed)) return true;
      if (trimmed.length < 95 && !/[.?!]$/.test(trimmed) && !/^["'“”‘’]/.test(trimmed)) {
        if (/^(?:Admissibility|Object Evidence|Documentary Evidence|Testimonial Evidence|Judicial Notice|Burden of Proof|Presumptions|Hearsay|Exceptions|Opinion Rule|Character Evidence|Offer and Objection|Dying Declaration|Statement of Decedent|Declaration against Interest|Act or Declaration About Pedigree|Family Reputation or Tradition|Common Reputation|Part of the Res Gestae|Res Gestae|Startling Occurrence|Verbal Acts|Records of Regularly Conducted|Entries in Official Records|Commercial Lists and the Like|Learned Treatises|Testimony or Deposition at|Residual Exception)\b/i.test(trimmed)) {
          return true;
        }
      }
      return false;
    }

    function sanitizeDigestSectionText(text, isFacts = false) {
      if (!text) return '';
      let cleaned = text.trim();

      // Strip trailing syllabus topic headers that bled into the end of a section
      cleaned = cleaned.replace(
        /\s*(?:[■•▪♦◦*-]?\s*)(?:Independently\s+Relevant\s+Statements|Dying\s+Declaration|Statement\s+of\s+Decedent|Declaration\s+against\s+Interest|Act\s+or\s+Declaration\s+About\s+Pedigree|Family\s+Reputation\s+or\s+Tradition(?:\s+Regarding\s+Pedigree)?|Common\s+Reputation|Part\s+of\s+the\s+Res\s+Gestae|Res\s+Gestae|Startling\s+Occurrence|Verbal\s+Acts|Records\s+of\s+Regularly\s+Conducted\s+Business(?:\s+Activities)?|Entries\s+in\s+Official\s+Records|Commercial\s+Lists\s+and\s+the\s+Like|Learned\s+Treatises|Testimony\s+or\s+Deposition\s+at(?:\s+a)?\s+Former\s+Proceeding|Residual\s+Exception|MODULE\s+\d+)\s*$/gi,
        ''
      ).trim();

      // Remove multi-case splicing artifacts (e.g., parallel trial court sentences spliced into Lea Mer)
      if (isFacts) {
        cleaned = cleaned.replace(
          /To counter this, the prosecution presented testimonies from the bus driver[\s\S]*?(?=The Court of Appeals affirmed the liability of petitioner|Petitioner appealed to the Supreme Court)/i,
          ''
        ).trim();
      }

      return cleaned;
    }

    function extractPartyTokens(title) {
      const STOPWORDS = new Set([
        'people', 'republic', 'court', 'appeals', 'philippines', 'versus', 'vs', 'the',
        'and', 'for', 'matter', 'inc', 'corp', 'corporation', 'co', 'g', 'r', 'no', 'nos',
        'heirs', 'of', 'in', 're', 'ca', 'sc', 'insurance', 'company', 'industries',
        'services', 'bank', 'enterprises', 'board', 'commission', 'department', 'city',
        'municipality', 'province', 'state', 'judicial', 'circuit', 'branch', 'judge',
        'atty', 'hon', 'jr', 'sr', 'ii', 'iii', 'iv', 'decision', 'resolution', 'notice',
        'las', 'los', 'del', 'dela', 'de', 'san', 'santa', 'santo', 'el', 'la', 'al', 'et', 'y',
        'spouses', 'estate', 'deceased', 'development', 'group', 'islands', 'vda'
      ]);

      const normTitle = normalizeDiacritics(title).replace(/^[■•▪♦◦*-]+\s*/, '');
      const parts = normTitle.split(/\s+(?:v\.?|vs\.?|versus)\s+/i);

      const getTokens = (str) => {
        const ySplit = (str || '').split(/\s+y\s+/i);
        const mainPart = ySplit[0];
        return mainPart
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .map(w => normalizePhoneticToken(w))
          .filter(w => w.length >= 2 && !STOPWORDS.has(w));
      };

      const p1Tokens = parts[0] ? getTokens(parts[0]) : [];
      const p2Tokens = parts[1] ? getTokens(parts[1]) : [];
      return { p1Tokens, p2Tokens, allTokens: [...new Set([...p1Tokens, ...p2Tokens])] };
    }

    function parseCaseDigestCompilation(rawText) {
      if (!rawText || !rawText.trim()) return [];

      let cleanedRaw = rawText
        .replace(/\r\n/g, '\n')
        .replace(/###\s*Page\s+\d+\s*/gi, '\n')
        .replace(/\[Page\s+\d+\]/gi, '\n');

      cleanedRaw = cleanedRaw.replace(
        /([.?!])\s+([A-Z][A-Za-z0-9\u00C0-\u017F\s.,'’"()&/–—-]{3,80}?\s+(?:v\.?|vs\.?|versus)\s+[A-Za-z0-9\u00C0-\u017F\s.,'’"()&/–—-]{2,80}?,?\s*(?:G\.R\.|A\.C\.|A\.M\.|B\.M\.|L-\d))/g,
        '$1\n$2'
      );

      const rawLines = cleanedRaw.split('\n').map(l => l.trim()).filter(Boolean);
      const lines = [];

      for (let i = 0; i < rawLines.length; i++) {
        let line = rawLines[i];

        const topicPrefixMatch = line.match(/^(?:[■•▪♦◦*-]?\s*)(?:Dying Declaration|Part of the Res Gestae|Entries in the Course of Business|Entries in Official Records|Commercial Lists|Learned Treatises|Common Reputation|Family Reputation|Pedigree|Statement Against Interest|Act or Declaration About Pedigree|Testimony or Deposition at a Former Proceeding)\s+([A-Z][A-Za-z0-9\u00C0-\u017F].*?\s+(?:v\.?|vs\.?|versus)\s+.*)$/i);
        if (topicPrefixMatch) {
          line = topicPrefixMatch[1].trim();
        }

        const inlineDocMatch = line.match(/^([■•▪♦◦*-]?\s*[A-Z0-9\u00C0-\u017F].*?\b(?:G\.R\.|A\.C\.|A\.M\.|B\.M\.|L-\d).*?\d{3,4})\s+[■•▪♦◦*-]?\s*Doctrine\b\s*[:.-]?\s*(.*)$/i);
        if (inlineDocMatch) {
          lines.push(inlineDocMatch[1].trim());
          lines.push('■ Doctrine');
          if (inlineDocMatch[2] && inlineDocMatch[2].trim()) {
            lines.push(inlineDocMatch[2].trim());
          }
          continue;
        }

        const secMatch = line.match(/^([■•▪♦◦*-]?\s*(?:Doctrine|Facts|Issues?|Ruling))\s*[:.-]?\s+(.+)$/);
        if (secMatch) {
          const headerPart = secMatch[1].replace(/^[■•▪♦◦*-]+\s*/, '').trim();
          const restPart = secMatch[2].trim();
          const isProse = /^(?:on|in|that|of|to|for|with|by|from|as|is|was|were|and|or|which|who|when|where)\b/.test(restPart);
          if (!isProse && (/^[■•▪♦◦*-]/.test(line) || /^[A-Z"“'(\[]/.test(restPart))) {
            lines.push(`■ ${headerPart}`);
            lines.push(restPart);
            continue;
          }
        }
        lines.push(line);
      }

      const caseEntries = [];
      for (let i = 0; i < lines.length; i++) {
        const isDoctrineLine = /^[■•▪♦◦*-]?\s*Doctrine\s*:?$/.test(lines[i]);
        if (!isDoctrineLine) continue;

        let captionLineIdx = -1;
        let captionText = '';

        for (let back = 1; back <= 4 && (i - back) >= 0; back++) {
          const candidate = lines[i - back];
          if (/^[■•▪♦◦*-]?\s*(?:Facts|Issues?|Ruling|Doctrine)\s*:?$/.test(candidate)) break;
          if (isCaseCaptionLine(candidate)) {
            captionLineIdx = i - back;
            captionText = candidate;
            if (captionLineIdx - 1 >= 0) {
              const prevLine = lines[captionLineIdx - 1];
              if (
                prevLine.length < 100 &&
                /\s+(?:v\.?|vs\.?|versus)\s*$/i.test(prevLine) &&
                !/[.?!]$/.test(prevLine)
              ) {
                captionLineIdx = captionLineIdx - 1;
                captionText = prevLine + ' ' + captionText;
              }
            }
            break;
          }
        }

        if (captionLineIdx !== -1) {
          caseEntries.push({
            captionIndex: captionLineIdx,
            doctrineIndex: i,
            rawCaption: captionText.replace(/^[■•▪♦◦*-]+\s*/, '').trim()
          });
        }
      }

      const digests = [];

      for (let c = 0; c < caseEntries.length; c++) {
        const curr = caseEntries[c];
        const nextCaptionIdx = (c + 1 < caseEntries.length) ? caseEntries[c + 1].captionIndex : lines.length;
        const blockLines = lines.slice(curr.doctrineIndex, nextCaptionIdx);

        while (blockLines.length > 2 && isTrailingModuleOrTopicHeader(blockLines[blockLines.length - 1])) {
          blockLines.pop();
        }

        let caseTitle = curr.rawCaption;
        let citation = '';
        const citeSplitMatch = curr.rawCaption.match(/^(.+?)(?:,\s*|\s+)((?:G\.R\.|A\.C\.|A\.M\.|B\.M\.|UDK|L-\d).*)$/i);
        if (citeSplitMatch) {
          caseTitle = citeSplitMatch[1].replace(/[,;]+$/, '').trim();
          citation = citeSplitMatch[2].trim();
        } else {
          const commaIdx = curr.rawCaption.indexOf(',');
          if (commaIdx !== -1) {
            caseTitle = curr.rawCaption.substring(0, commaIdx).trim();
            citation = curr.rawCaption.substring(commaIdx + 1).trim();
          }
        }

        const filteredBlockLines = [];
        for (let k = 0; k < blockLines.length; k++) {
          const l = blockLines[k];
          if (isTrailingModuleOrTopicHeader(l)) continue;
          if (k > 0 && /^[■•▪♦◦*-]?\s*Issues?\s*:?$/.test(l)) {
            const prevLine = filteredBlockLines[filteredBlockLines.length - 1] || '';
            const nextLine = (k + 1 < blockLines.length) ? blockLines[k + 1].replace(/^[■•▪♦◦*-]+\s*/, '').trim() : '';
            const prevEndsSentence = /[.?!:"”']$/.test(prevLine);
            const nextStartsLower = /^[a-z]/.test(nextLine);
            if (!prevEndsSentence && nextStartsLower) continue;
          }
          filteredBlockLines.push(l);
        }

        let factsIdx = -1;
        let issueIdx = -1;
        let rulingIdx = -1;

        for (let k = 1; k < filteredBlockLines.length; k++) {
          const l = filteredBlockLines[k];
          if (factsIdx === -1 && /^[■•▪♦◦*-]?\s*Facts\s*:?$/.test(l)) {
            factsIdx = k;
          } else if (factsIdx !== -1 && issueIdx === -1) {
            if (/^[■•▪♦◦*-]?\s*Issues?\s*:?$/.test(l) || /^[■•▪♦◦*-]?\s*Whether\s+(?:or\s+not\b|the\b|a\b|an\b|petitioner|respondent|accused|complainant)/i.test(l)) {
              issueIdx = k;
            }
          } else if (factsIdx !== -1 && rulingIdx === -1 && /^[■•▪♦◦*-]?\s*Ruling\s*:?$/.test(l)) {
            rulingIdx = k;
          }
        }

        if (factsIdx !== -1 && rulingIdx === -1) {
          for (let k = (issueIdx !== -1 ? issueIdx + 1 : factsIdx + 1); k < filteredBlockLines.length; k++) {
            if (/^[■•▪♦◦*-]?\s*Ruling\s*:?$/.test(filteredBlockLines[k])) {
              rulingIdx = k;
              break;
            }
          }
        }

        const joinParagraphs = (arr) => {
          const out = [];
          let currPara = '';
          for (const line of arr) {
            if (/^[■•▪♦◦*-]?\s*(?:Doctrine|Facts|Issues?|Ruling)\s*:?$/.test(line)) continue;
            const cleanedLine = line.replace(/^[■•▪♦◦]+\s*/, '').trim();
            if (!cleanedLine) continue;
            if (!currPara) {
              currPara = cleanedLine;
            } else {
              const prevEndsSentence = /[.?!:"”']$/.test(currPara);
              const startsNewPara = /^[■•▪]/.test(line) || /^(?:On\s+[A-Z]|In\s+\d{4}|Meanwhile|Subsequently|Aggrieved|However|Moreover|Furthermore|WHEREFORE|ACCORDINGLY|First\.|Second\.|Third\.|Q:|A:|Court:)/.test(cleanedLine);
              if (prevEndsSentence && startsNewPara) {
                out.push(currPara);
                currPara = cleanedLine;
              } else {
                currPara += ' ' + cleanedLine;
              }
            }
          }
          if (currPara) out.push(currPara);
          return out.join('\n\n');
        };

        let doctrineText = '';
        let factsText = '';
        let issueText = '';
        let rulingText = '';

        if (factsIdx !== -1) {
          doctrineText = sanitizeDigestSectionText(joinParagraphs(filteredBlockLines.slice(1, factsIdx)), false);
          const endOfFacts = issueIdx !== -1 ? issueIdx : (rulingIdx !== -1 ? rulingIdx : filteredBlockLines.length);
          factsText = sanitizeDigestSectionText(joinParagraphs(filteredBlockLines.slice(factsIdx + 1, endOfFacts)), true);

          if (issueIdx !== -1) {
            const endOfIssue = rulingIdx !== -1 ? rulingIdx : filteredBlockLines.length;
            const issueSliceStart = /^[■•▪♦◦*-]?\s*Issues?\s*:?$/.test(filteredBlockLines[issueIdx]) ? issueIdx + 1 : issueIdx;
            issueText = sanitizeDigestSectionText(joinParagraphs(filteredBlockLines.slice(issueSliceStart, endOfIssue)), false);
          }
          if (rulingIdx !== -1) {
            rulingText = sanitizeDigestSectionText(joinParagraphs(filteredBlockLines.slice(rulingIdx + 1)), false);
          }
        } else {
          doctrineText = sanitizeDigestSectionText(joinParagraphs(filteredBlockLines.slice(1)), false);
        }

        const docketId = extractDocketId(curr.rawCaption);
        const { p1Tokens, p2Tokens, allTokens } = extractPartyTokens(caseTitle);
        const expanded = expandAcronyms(caseTitle);
        const expandedTokens = extractPartyTokens(expanded).allTokens;

        digests.push({
          id: `${currentSubjectName}_digest_${c}_${docketId || Math.random().toString(36).substr(2, 5)}`,
          subject: currentSubjectName,
          caseTitle: caseTitle,
          cleanTitle: cleanAlphanumeric(caseTitle),
          citation: citation,
          grNumber: docketId,
          p1Tokens: p1Tokens,
          p2Tokens: p2Tokens,
          allTokens: [...new Set([...allTokens, ...expandedTokens])],
          doctrine: doctrineText,
          facts: factsText,
          issue: issueText,
          ruling: rulingText
        });
      }

      return digests;
    }

    async function buildSearchIndex() {
      inMemoryChunks = [];
      if (!state.loadedFiles || state.loadedFiles.length === 0) {
        const scopeVal = document.getElementById('typedScopeInput')?.value || '';
        updateScopePreviewUI(scopeVal);
        return;
      }

      const combinedText = state.loadedFiles.map(f => f.text).join('\n\n');
      const extractedDigests = parseCaseDigestCompilation(combinedText);
      if (extractedDigests.length > 0) {
        await dbClearSubjectStore('digests');
        for (const d of extractedDigests) {
          await dbSave('digests', d);
        }
        state.parsedDigests = extractedDigests;
      }

      const seenFingerprints = new Set();

      for (const file of state.loadedFiles) {
        const rawFileText = (file.text || '').replace(/\r\n/g, '\n');
        const pageMarkers = rawFileText.match(/\[Page\s+\d+\]|###\s*Page\s+\d+/gi) || [];
        const isSlideDeck = /ppt/i.test(file.name) || (pageMarkers.length > 20 && (rawFileText.length / pageMarkers.length) < 900);

        if (isSlideDeck) {
          const pages = rawFileText.split(/(?=\[Page\s+\d+\]|###\s*Page\s+\d+)/i).map(p => p.trim()).filter(Boolean);
          for (let i = 0; i < pages.length; i += 2) {
            const windowText = pages.slice(i, i + 3).join('\n').replace(/\[Page\s+\d+\]|###\s*Page\s+\d+/gi, ' ').trim();
            if (windowText.length < 25) continue;
            const docket = extractDocketId(windowText);

            inMemoryChunks.push({
              source: file.name,
              kind: 'SLIDE',
              text: windowText,
              lower: windowText.toLowerCase(),
              phonetic: normalizePhoneticToken(windowText.substring(0, 600)),
              docketNum: docket
            });
          }
          continue;
        }

        const cleanFileText = rawFileText.replace(/\[Page\s+\d+\]|###\s*Page\s+\d+/gi, '\n');
        const blocks = cleanFileText.split(
          /(?=(?:^|\n)\s*[A-Z][A-Za-z0-9\s.,'’()-]{2,85}\s+(?:v\.|vs\.)\s+[A-Z][A-Za-z0-9\s.,'’()-]{2,85},\s*(?:G\.R\.|A\.C\.|A\.M\.|\d+\s+Phil)|(?:^|\n)\s*(?:CHAPTER|Chapter|MODULE|Module|RULE|Rule|TITLE|Title)\s+\d+\b|(?:^|\n)\s*(?:SECTION|Section|Sec\.|ARTICLE|Article|Art\.)\s+\d+\s*\.\s*[A-Z])/
        );

        let currentRule = "130";

        for (const blk of blocks) {
          const trimmed = blk.trim();
          if (trimmed.length < 30) continue;

          const ruleHeaderMatch = trimmed.match(/^(?:RULE|Rule)\s*(\d{1,3})\b/m);
          if (ruleHeaderMatch) currentRule = ruleHeaderMatch[1];

          const firstLine = trimmed.substring(0, 260);
          const docket = extractDocketId(firstLine);
          const isCaseDigest = !!(docket && /\b(?:v\.|vs\.|In\s+re)\b/i.test(firstLine));

          const headerMatch = trimmed.match(/^(?:SECTION|Section|Sec\.|ARTICLE|Article|Art\.)\s*(\d{1,3})\s*\.\s*([A-Z][A-Za-z0-9\s,;'’()–—-]+?)\s*(?:[.—:-]+|\n)/);
          const secNum = headerMatch ? headerMatch[1] : null;

          if (/\(\s*Transposed\s+to\b/i.test(trimmed.substring(0, 160))) continue;

          const fingerprint = trimmed.substring(0, 140).toLowerCase().replace(/[^a-z0-9]/g, '');
          if (seenFingerprints.has(fingerprint)) continue;
          seenFingerprints.add(fingerprint);

          inMemoryChunks.push({
            source: file.name,
            kind: isCaseDigest ? 'CASE_DIGEST' : (headerMatch ? 'STATUTE' : 'COMMENTARY'),
            text: trimmed,
            lower: trimmed.toLowerCase(),
            phonetic: normalizePhoneticToken(firstLine),
            docketNum: docket,
            ruleNum: currentRule,
            secNum: secNum,
            isStatutoryHeader: !!headerMatch
          });
        }
      }

      const scopeVal = document.getElementById('typedScopeInput')?.value || '';
      updateScopePreviewUI(scopeVal);
    }

    function findMatchingDigest(caseTitle, citation = '') {
      if (!state.parsedDigests || state.parsedDigests.length === 0) return null;

      const targetDocket = extractDocketId(caseTitle + ' ' + citation);
      if (targetDocket) {
        const byExactDocket = state.parsedDigests.find(d => d.grNumber && d.grNumber === targetDocket);
        if (byExactDocket) return byExactDocket;

        const byMultiDocket = state.parsedDigests.find(d => {
          if (!d.grNumber) return false;
          const parts = d.grNumber.split('-');
          return parts[0].length >= 5 && parts[0] === targetDocket.split('-')[0];
        });
        if (byMultiDocket) return byMultiDocket;
      }

      const targetClean = cleanAlphanumeric(caseTitle);
      if (targetClean.length >= 6) {
        const byExactClean = state.parsedDigests.find(d => d.cleanTitle === targetClean);
        if (byExactClean) return byExactClean;
      }

      const { p1Tokens, p2Tokens } = extractPartyTokens(expandAcronyms(caseTitle));
      if (p1Tokens.length === 0 && p2Tokens.length === 0) return null;

      let bestMatch = null;
      let bestScore = 0;

      for (const d of state.parsedDigests) {
        let score = 0;
        let p1Hit = p1Tokens.length === 0;
        let p2Hit = p2Tokens.length === 0;

        for (const t of p1Tokens) {
          if (d.p1Tokens?.includes(t) || d.allTokens?.includes(t)) {
            score += 60;
            p1Hit = true;
          }
        }
        for (const t of p2Tokens) {
          if (d.p2Tokens?.includes(t) || d.allTokens?.includes(t)) {
            score += 60;
            p2Hit = true;
          }
        }

        if (p1Hit && p2Hit && score > bestScore) {
          bestScore = score;
          bestMatch = d;
        }
      }

      return bestScore >= 60 ? bestMatch : null;
    }

    function retrieveVerbatimProvision(queryText) {
      const q = queryText || "";
      const lowerQuery = q.toLowerCase();

      // Guard: Never default to Rules 128-133 if query explicitly mentions an A.M. circular or special convention
      const isSpecialLaw = /(?:A\.M\.|A\.M\b|Hague|Convention|Circular|R\.A\.|Republic\s+Act)/i.test(q);

      // 1. Evidence & Rules of Court check (Rules 128 through 133)
      const targetSecNum = extractSectionNumberToken(q);
      const explicitRule = extractRuleNumberToken(q);

      // Only default to Rule 130 if it is NOT a special administrative matter/circular
      if (!isSpecialLaw || explicitRule) {
        const targetRuleNum = explicitRule || (lowerQuery.includes('rule 133') ? "133" : (lowerQuery.includes('rule 129') ? "129" : (lowerQuery.includes('rule 128') ? "128" : "130")));

        if (targetSecNum && CANONICAL_2019_CODAL_MAP[`${targetRuleNum}:${targetSecNum}`]) {
          return CANONICAL_2019_CODAL_MAP[`${targetRuleNum}:${targetSecNum}`].text;
        }

        // Concordance lookup
        for (const [key, val] of Object.entries(EVIDENCE_2019_CONCORDANCE)) {
          if (lowerQuery.includes(key)) {
            const rNum = extractRuleNumberToken(val.rule) || "130";
            const sNum = extractSectionNumberToken(val.section);
            if (sNum && CANONICAL_2019_CODAL_MAP[`${rNum}:${sNum}`]) {
              return CANONICAL_2019_CODAL_MAP[`${rNum}:${sNum}`].text;
            }
          }
        }
      }

      // 2. Multi-Subject Registry Check (Civil, Criminal, Labor, Ethics, Commercial, Tax)
      const subjectMap = UNIVERSAL_SUBJECT_CODAL_REGISTRY[currentSubjectName];
      if (subjectMap) {
        // Match Article numbers: e.g. "Article 1156", "Art. 11", "Art 297"
        const artMatch = q.match(/\b(?:Articles?|Arts?\.?|Sections?|Secs?\.?)\s*(\d{1,4}[A-Za-z-]*)\b/i);
        if (artMatch && artMatch[1]) {
          const artKey = artMatch[1];
          if (subjectMap[artKey]) return subjectMap[artKey].text;
        }
        for (const [key, entry] of Object.entries(subjectMap)) {
          if (lowerQuery.includes(entry.title.toLowerCase()) || lowerQuery.includes(key.toLowerCase())) {
            return entry.text;
          }
        }
      }

      // 3. Fallback to loaded PDF commentary/source chunks
      if (inMemoryChunks.length > 0 && targetSecNum && (!isSpecialLaw || explicitRule)) {
        const targetRule = explicitRule || "130";
        const matches = inMemoryChunks.filter(c =>
          c.isStatutoryHeader &&
          c.secNum === targetSecNum &&
          c.ruleNum === targetRule
        );
        if (matches.length > 0) {
          return matches[0].text.split(/\n\n+/)[0].trim();
        }
      }

      return "";
    }

    function checkConcordanceNote(topicText) {
      if (!topicText) return null;
      const isSpecialLaw = /(?:A\.M\.|A\.M\b|Hague|Convention|Circular|R\.A\.|Republic\s+Act)/i.test(topicText);
      if (isSpecialLaw && !extractRuleNumberToken(topicText)) {
        return null; // Suppress Rule 130 default anchor on special administrative rules
      }
      let lower = topicText.toLowerCase();
      for (const [key, val] of Object.entries(EVIDENCE_2019_CONCORDANCE)) {
        if (lower.includes(key)) {
          return `${val.name} is governed strictly by ${val.rule}, ${val.section}. ${val.note}`;
        }
      }
      const secNum = extractSectionNumberToken(topicText);
      const ruleNum = extractRuleNumberToken(topicText) || "130";
      const canonical = secNum ? CANONICAL_2019_CODAL_MAP[`${ruleNum}:${secNum}`] : null;
      if (canonical) {
        return `Rule ${ruleNum}, Section ${secNum} (${canonical.title}) — Verbatim Statutory Anchor Active.`;
      }
      return null;
    }

    function retrieveRelevantExcerpts(queryText, maxChars = 3200) {
      const verbatim = retrieveVerbatimProvision(queryText);
      const targetDocket = extractDocketId(queryText);
      const STOPWORDS = new Set(['the','and','for','that','this','with','under','from','shall','when','upon','which','what','rule','section','article','sec','art','people','court','appeals','inc','corp','heirs','spouses']);
      const tokens = (queryText || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !STOPWORDS.has(t));

      const phoneticTokens = tokens.map(t => normalizePhoneticToken(t)).filter(t => t.length >= 4);
      const scored = [];

      for (let i = 0; i < inMemoryChunks.length; i++) {
        const chunk = inMemoryChunks[i];
        let score = 0;

        if (targetDocket && chunk.docketNum === targetDocket) {
          score += 200;
          if (chunk.kind === 'CASE_DIGEST') score += 50;
        }

        for (let j = 0; j < tokens.length; j++) {
          if (chunk.lower.includes(tokens[j])) score += 6;
        }
        for (let k = 0; k < phoneticTokens.length; k++) {
          if (chunk.phonetic && chunk.phonetic.includes(phoneticTokens[k])) score += 15;
        }

        if (score >= 12) scored.push({ chunk, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const outputParts = [];
      let currentLength = 0;

      if (verbatim) {
        outputParts.push(`[VERBATIM CODAL PROVISION]:\n${verbatim}`);
        currentLength += verbatim.length;
      }

      const seen = new Set();
      for (const item of scored.slice(0, 3)) {
        const fp = item.chunk.text.substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seen.has(fp)) continue;
        seen.add(fp);

        const remainingBudget = Math.max(700, maxChars - currentLength);
        const snippet = item.chunk.text.length <= remainingBudget
          ? item.chunk.text
          : item.chunk.text.substring(0, remainingBudget).trim() + " ... [Excerpt Truncated]";
        outputParts.push(`[SOURCE EXCERPT - ${item.chunk.source} (${item.chunk.kind})]:\n${snippet}`);
        currentLength += snippet.length;
        if (currentLength >= maxChars) break;
      }

      return outputParts.join('\n\n').trim();
    }

    async function reparseLoadedSources() {
      await buildSearchIndex();
      renderSourcesList();
      evaluateGatekeeperState();
      alert(`Re-indexed ${state.loadedFiles.length} file(s): ${state.parsedDigests.length} Structured Case Digests and ${inMemoryChunks.length} Statutory/Reviewer Chunks ready.`);
    }

    // ---------------------------------------------------------------------------
    // HARDENED DETERMINISTIC SCOPE UNBUNDLER & STRICT SAME-TOPIC PAIRING ENGINE
    // ---------------------------------------------------------------------------
    function stitchWrappedSyllabusLines(rawText) {
      const rawLines = (rawText || '').replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
      const stitched = [];

      const PREPOSITIONS_CONJUNCTIONS = new Set([
        'of', 'in', 'at', 'on', 'to', 'for', 'from', 'with', 'by', 'as', 'about',
        'regarding', 'and', 'or', 'the', 'a', 'an', 'under', 'between', 'against',
        'than', 'that', 'which', 'who', 'whose', 'whom', 'where', 'when', 'into', 'onto'
      ]);

      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (stitched.length === 0) {
          stitched.push(line);
          continue;
        }

        // If a line contains an embedded Roman numeral sub-topic at the end (e.g., "...January 29, 2018 ii. Verbal Acts"), split it cleanly!
        const embeddedSubTopic = line.match(/^(.*?\b\d{4}\]?)\s+((?:[ivx]+|[a-n])\.\s+[A-Z].*)$/i);
        if (embeddedSubTopic) {
          stitched.push(embeddedSubTopic[1].trim());
          stitched.push(embeddedSubTopic[2].trim());
          continue;
        }

        const prev = stitched[stitched.length - 1];
        const prevWords = prev.split(/\s+/);
        const lastWord = prevWords[prevWords.length - 1].toLowerCase().replace(/[^a-z]/g, '');

        const prevEndsDangling =
          /[,:\-–—\(\[\'\"]$/.test(prev) ||
          /\b(?:G\.?\s*R\.?|A\.?\s*C\.?|A\.?\s*M\.?|B\.?\s*M\.?|UDK|L-)\s*(?:Nos?\.?)?$/i.test(prev) ||
          /\s+(?:v\.?|vs\.?|versus)\s*$/i.test(prev) ||
          PREPOSITIONS_CONJUNCTIONS.has(lastWord) ||
          prev.endsWith('“') || prev.endsWith('"') || prev.endsWith("'");

        const startsContinuation =
          /^(?:Nos?\.?|\d{4,8}|\[?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\d{1,2},\s*\d{4})\b/i.test(line) ||
          /^(?:Inc\.|Corp\.|Co\.|Ltd\.|Jr\.|Sr\.|et\s+al|represented\s+by|Services|Insurance|Resolution|\(Resolution\)|\(Resoltuion\)|Notice|Decision)\b/i.test(line) ||
          /^[a-z”’"\)\]]/.test(line);

        if ((prevEndsDangling || startsContinuation) && !/^(?:[a-n]|[ivx]+)\.\s+/i.test(line) && !/^-\s+[A-Z]/.test(line)) {
          stitched[stitched.length - 1] += ' ' + line;
        } else {
          stitched.push(line);
        }
      }
      return stitched;
    }

    function parseSyllabusCases(text) {
      if (!text || !text.trim()) return [];
      const stitched = stitchWrappedSyllabusLines(text);
      const cases = [];
      const seenCompositeKeys = new Set();
      let currentTopic = `Assigned ${currentSubjectName} Topic`;

      for (const block of stitched) {
        const hasVersus = /\s+(?:v\b\.?|vs\b\.?|versus)\s+/i.test(block);
        const isInRe = /^[-*•■\s]*(?:In\s+re\b|In\s+the\s+matter\s+of\b)/i.test(block);

        if (!hasVersus && !isInRe) {
          let topicCandidate = block
            .replace(/^[-*•■\s]+/, '')
            .replace(/^(?:[a-z]|\d+|[ivx]+)\.\s*/i, '')
            .trim();
          if (topicCandidate && !/^(?:module|part|unit|chapter)\b/i.test(topicCandidate) && !/(?:Sections?|Secs?\.?)\s*\d+\s*(?:[-–—]|to)\s*\d+/i.test(topicCandidate)) {
            currentTopic = topicCandidate.split(/[,;\n]/)[0].trim() || topicCandidate;
          }
          continue;
        }

        let clean = block
          .replace(/^[-*•■\s]+/, '')
          .replace(/^(?:[a-z]|\d+|[ivx]+)\.\s*/i, '')
          .trim();

        // Strip any accidentally attached trailing sub-heading (e.g. "ii. Verbal Acts")
        clean = clean.replace(/\s+(?:[ivx]+|[a-n])\.\s+[A-Z][A-Za-z\s]+$/i, '').trim();

        let caseTitle = "";
        let citation = "";

        if (isInRe) {
          const splitParts = clean.split(/,\s*(?:Notice|G\.R\.|A\.M\.|A\.C\.|B\.M\.|Resolution|\d{4}|\[?(?:January|February|March|April|May|June|July|August|September|October|November|December))/i);
          caseTitle = splitParts[0].trim();
          citation = clean.substring(caseTitle.length).replace(/^,\s*/, '').trim();
        } else {
          const match = clean.match(/^([A-Za-z0-9\u00C0-\u017F\s.,'’"()&/–—-]+?\s+(?:v\b\.?|vs\b\.?|versus)\s+[A-Za-z0-9\u00C0-\u017F\s.,'’"()&/–—-]+?)(?:(?:,\s*|\s+)(?:G\.R\.|A\.M\.|A\.C\.|B\.M\.|UDK|L-|\d{4}|\[?(?:January|February|March|April|May|June|July|August|September|October|November|December)|\(Resoltuion\)|\(Resolution\))|$)/i);
          if (match && match[1]) {
            caseTitle = match[1].trim();
            citation = clean.substring(caseTitle.length).replace(/^,\s*/, '').trim();
          } else {
            const commaIdx = clean.indexOf(',');
            if (commaIdx !== -1) {
              caseTitle = clean.substring(0, commaIdx).trim();
              citation = clean.substring(commaIdx + 1).trim();
            } else {
              caseTitle = clean;
            }
          }
        }

        caseTitle = caseTitle.replace(/[,;]+$/, '').replace(/\[+$/, '').trim();
        if (caseTitle.length >= 5) {
          const docket = extractDocketId(caseTitle + ' ' + citation) || cleanAlphanumeric(caseTitle);
          // Composite key prevents duplicate lines within the SAME topic while allowing the same case under a DIFFERENT syllabus doctrine
          const compositeKey = `${docket}::${currentTopic.toLowerCase()}`;
          if (seenCompositeKeys.has(compositeKey)) continue;
          seenCompositeKeys.add(compositeKey);

          cases.push({
            topic: caseTitle,
            case_title: caseTitle,
            legal_subject: currentTopic,
            rule_citation: citation ? `${currentTopic} · ${citation}` : currentTopic,
            citation: citation || "",
            compositeKey: compositeKey,
            isCase: true
          });
        }
      }

      return cases;
    }

    // STRICT SAME-TOPIC COMPANION PAIRING (REJECTS CROSS-TOPIC MISMATCHES)
    function buildCompanionCasePairs(caseItems, includeUnpairedAsSingleFIR = false) {
      const pairs = [];
      const bySubject = {};
      for (const c of caseItems) {
        const subj = (c.legal_subject || 'General').trim();
        if (!bySubject[subj]) bySubject[subj] = [];
        bySubject[subj].push(c);
      }

      for (const [subjName, group] of Object.entries(bySubject)) {
        for (let i = 0; i < group.length; i += 2) {
          if (i + 1 < group.length) {
            const cA = group[i];
            const cB = group[i + 1];
            pairs.push({
              topic: `${cA.case_title} vs. ${cB.case_title}`,
              case_title: `${cA.case_title} vs. ${cB.case_title}`,
              caseA: cA,
              caseB: cB,
              legal_subject: subjName,
              rule_citation: `Comparative Synthesis · ${subjName}`,
              isCase: true,
              isDualPair: true,
              forcedDimensionId: 8
            });
          } else if (includeUnpairedAsSingleFIR) {
            // Odd leftover case within a topic drops cleanly to Dimension 7 (Complete Single-Case FIR) instead of pairing across unrelated topics
            const single = group[i];
            pairs.push({
              ...single,
              forcedDimensionId: 7
            });
          }
        }
      }

      return pairs;
    }

    function expandDeterministicScopeItems(scopeText) {
      const raw = (scopeText || "").trim();
      if (!raw) return [];

      const rawCodalTopics = [];
      const seenCodalKeys = new Set();

      const addCodalTopicUnique = (topic, rule) => {
        const dedupKey = 'codal_' + topic.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seenCodalKeys.has(dedupKey)) return;
        seenCodalKeys.add(dedupKey);
        rawCodalTopics.push({ topic, rule_citation: rule, isCase: false });
      };

      const AM_DOCKET_ALIAS_MAP = {
        "004-07-sc": "child witness",
        "00-4-07-sc": "child witness",
        "06-11-5-sc": "dna",
        "01-7-01-sc": "electronic evidence",
        "21-06-08-sc": "body-worn",
        "12-8-8-sc": "judicial affidavit",
        "25-02-17-sc": "hague"
      };

      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const subLower = currentSubjectName.toLowerCase();

      // =========================================================================
      // PASS 1: LINE-BY-LINE SPECIAL ADMINISTRATIVE RULES & CIRCULARS REGISTRY
      // =========================================================================
      const matchedSpecialRulesThisRun = new Set();
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        let lineMatched = false;

        for (const [amNum, regKey] of Object.entries(AM_DOCKET_ALIAS_MAP)) {
          if (lowerLine.includes(amNum)) {
            if (!matchedSpecialRulesThisRun.has(regKey)) {
              matchedSpecialRulesThisRun.add(regKey);
              if (SPECIAL_RULES_TOPIC_REGISTRY[regKey]) {
                SPECIAL_RULES_TOPIC_REGISTRY[regKey].forEach(t => addCodalTopicUnique(t.topic, t.rule));
              }
            }
            lineMatched = true;
            break;
          }
        }

        if (!lineMatched) {
          for (const [key, topicsList] of Object.entries(SPECIAL_RULES_TOPIC_REGISTRY)) {
            if (lowerLine.includes(key) && !lowerLine.includes('v.') && !lowerLine.includes('vs.')) {
              if (!matchedSpecialRulesThisRun.has(key)) {
                matchedSpecialRulesThisRun.add(key);
                topicsList.forEach(t => addCodalTopicUnique(t.topic, t.rule));
              }
              break;
            }
          }
        }
      }

      // =========================================================================
      // PASS 2: EXPLICIT SECTION & ARTICLE RANGES (LINE-BY-LINE AVOID BLEED)
      // =========================================================================
      for (const line of lines) {
        // Skip lines already handled by special law dockets
        if (/(?:A\.M\.|A\.M\b|Hague|Convention|Circular)/i.test(line) && !/\bRule\s*\d+/i.test(line)) {
          continue;
        }

        // Check for cross-rule ranges (e.g. Rule 128 Section 1 - Rule 129 Section 4)
        const crossRuleMatch = line.match(/Rule\s*(\d{1,3})\s*(?:Section|Sec\.)\s*(\d{1,3})\s*(?:[-–—]|to|through)\s*Rule\s*(\d{1,3})\s*(?:Section|Sec\.)\s*(\d{1,3})/i);
        if (crossRuleMatch) {
          const rStart = parseInt(crossRuleMatch[1], 10);
          const sStart = parseInt(crossRuleMatch[2], 10);
          const rEnd = parseInt(crossRuleMatch[3], 10);
          const sEnd = parseInt(crossRuleMatch[4], 10);

          for (let r = rStart; r <= rEnd; r++) {
            const startS = (r === rStart) ? sStart : 1;
            const endS = (r === rEnd) ? sEnd : (r === 128 ? 4 : (r === 129 ? 4 : 54));
            for (let s = startS; s <= endS; s++) {
              const key = `${r}:${s}`;
              if (CANONICAL_2019_CODAL_MAP[key]) {
                const entry = CANONICAL_2019_CODAL_MAP[key];
                addCodalTopicUnique(`${entry.title} (Rule ${r}, Section ${s})`, `Rule ${r}, Section ${s}`);
              } else {
                addCodalTopicUnique(`Rule ${r}, Section ${s}`, `Rule ${r}, Section ${s}`);
              }
            }
          }
          continue;
        }

        // Standard single-rule range (e.g. Rule 130 Section 37-50 or Articles 1156 to 1160)
        const rangeRegex = /(?:(?:Rule|Articles?|Arts?\.?)\s*(\d{1,4})[,:\s]+)?(?:Sections?|Secs?\.?|Articles?|Arts?\.?)\s*(\d{1,4})\s*(?:[-–—]|to|through)\s*(\d{1,4})\b/gi;
        let rangeMatch;
        while ((rangeMatch = rangeRegex.exec(line)) !== null) {
          const ruleExplicit = rangeMatch[1] || extractRuleNumberToken(line);
          const startSec = parseInt(rangeMatch[2], 10);
          const endSec = parseInt(rangeMatch[3], 10);
          const hasArticleWord = /\b(?:Articles?|Arts?\.?)\b/i.test(line);

          if (startSec <= endSec && (endSec - startSec) <= 60) {
            for (let s = startSec; s <= endSec; s++) {
              const sKey = String(s);

              if (ruleExplicit) {
                if (ruleExplicit === "130" && DETERMINISTIC_SUB_PROVISIONS[sKey]) {
                  DETERMINISTIC_SUB_PROVISIONS[sKey].forEach(sub => addCodalTopicUnique(sub.subTopic, sub.rule));
                } else if (CANONICAL_2019_CODAL_MAP[`${ruleExplicit}:${sKey}`]) {
                  const entry = CANONICAL_2019_CODAL_MAP[`${ruleExplicit}:${sKey}`];
                  addCodalTopicUnique(`${entry.title} (Rule ${ruleExplicit}, Section ${sKey})`, `Rule ${ruleExplicit}, Section ${sKey}`);
                } else {
                  addCodalTopicUnique(`Rule ${ruleExplicit}, Section ${sKey}`, `Rule ${ruleExplicit}, Section ${sKey}`);
                }
              } else if (hasArticleWord || subLower.includes("criminal") || subLower.includes("civil") || subLower.includes("labor")) {
                if (subLower.includes("criminal")) {
                  addCodalTopicUnique(`Revised Penal Code: Article ${sKey}`, `RPC · Art. ${sKey}`);
                } else if (subLower.includes("civil")) {
                  addCodalTopicUnique(`Civil Code: Article ${sKey}`, `Civil Code · Art. ${sKey}`);
                } else if (subLower.includes("labor")) {
                  addCodalTopicUnique(`Labor Code: Article ${sKey}`, `Labor Code · Art. ${sKey}`);
                } else {
                  addCodalTopicUnique(`${currentSubjectName}: Article ${sKey}`, `${currentSubjectName} · Art. ${sKey}`);
                }
              } else if (subLower.includes("tax")) {
                addCodalTopicUnique(`Tax Code (NIRC): Section ${sKey}`, `NIRC · Sec. ${sKey}`);
              } else if (subLower.includes("commercial")) {
                addCodalTopicUnique(`Commercial Law: Section ${sKey}`, `Commercial Law · Sec. ${sKey}`);
              } else {
                if (DETERMINISTIC_SUB_PROVISIONS[sKey]) {
                  DETERMINISTIC_SUB_PROVISIONS[sKey].forEach(sub => addCodalTopicUnique(sub.subTopic, sub.rule));
                } else if (CANONICAL_2019_CODAL_MAP[`130:${sKey}`]) {
                  const entry = CANONICAL_2019_CODAL_MAP[`130:${sKey}`];
                  addCodalTopicUnique(`${entry.title} (Rule 130, Section ${sKey})`, `Rule 130, Section ${sKey}`);
                } else {
                  addCodalTopicUnique(`Rule 130, Section ${sKey}`, `Rule 130, Section ${sKey}`);
                }
              }
            }
          }
        }
      }

      // =========================================================================
      // PASS 3: CASE CITATIONS (EXTRACTED VIA PARSESYLLABUSCASES)
      // =========================================================================
      const caseItems = parseSyllabusCases(raw);

      // =========================================================================
      // PASS 4: DOCTRINAL TOPICS & SYLLABUS HEADINGS (NON-CASE, NON-RANGE)
      // =========================================================================
      const stitched = stitchWrappedSyllabusLines(raw);
      for (const line of stitched) {
        if (/^(?:Module\s+\d+|Part\s+\d+|Do\s+not\s+include)/i.test(line)) continue;
        if (/(?:Sections?|Secs?\.?|Articles?|Arts?\.?)\s*\d+\s*(?:[-–—]|to|through)\s*\d+/i.test(line)) continue;
        if (/Rule\s*\d+\s*(?:Section|Sec\.)/i.test(line)) continue;
        if (/(?:A\.M\.|A\.M\b|Hague|Convention|Circular)/i.test(line)) continue;

        const cleanLine = line.replace(/^[-*•■\s]+/, '').replace(/^(?:[a-z]|\d+|[ivx]+)[\.\)]\s*/i, '').trim();
        if (cleanLine.length < 4 || cleanLine.length > 120) continue;

        const isCaseLine = /\s+(?:v\b\.?|vs\b\.?|versus)\s+/i.test(cleanLine) ||
                           /\b(?:G\.R\.|A\.C\.|A\.M\.|B\.M\.|UDK|L-\d)\b/i.test(cleanLine) ||
                           /^(?:In\s+re\b|In\s+the\s+matter\s+of\b)/i.test(cleanLine);
        if (isCaseLine) continue;

        addCodalTopicUnique(cleanLine, sanitizeCitation(cleanLine));
      }

      // =========================================================================
      // PASS 5: UNIFIED AGGREGATION ACROSS ACTIVE DIMENSIONS
      // =========================================================================
      const activeIds = state.activeDimensions.length > 0 ? state.activeDimensions : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const activeCodalDims = activeIds.filter(d => [1, 2, 3].includes(d));
      const activeReviewerDims = activeIds.filter(d => [1, 4, 9, 10].includes(d));
      const activeSingleCaseDims = activeIds.filter(d => [5, 6, 7].includes(d));
      const hasDualCaseDim = activeIds.includes(8);
      const isPureCodalMode = activeIds.every(d => [1, 2, 3].includes(d));
      const isPureReviewerMode = activeIds.every(d => [1, 4, 9, 10].includes(d));

      const finalPool = [];

      // Pure Codal Multiplier (Dimensions 1, 2, 3)
      if (isPureCodalMode && rawCodalTopics.length > 0) {
        for (const cItem of rawCodalTopics) {
          for (const dId of activeCodalDims) {
            const dReg = DIMENSIONS_REGISTRY[dId];
            finalPool.push({
              ...cItem,
              topic: `${cItem.topic} [${dReg.exportTag}]`,
              baseTopic: cItem.topic,
              forcedDimensionId: dId,
              isCase: false
            });
          }
        }
        return finalPool;
      }

      // Pure Reviewer Multiplier (Dimensions 1, 4, 9, 10)
      if (isPureReviewerMode && rawCodalTopics.length > 0) {
        for (const rItem of rawCodalTopics) {
          for (const dId of activeReviewerDims) {
            const dReg = DIMENSIONS_REGISTRY[dId];
            finalPool.push({
              ...rItem,
              topic: `${rItem.topic} [${dReg.exportTag}]`,
              baseTopic: rItem.topic,
              forcedDimensionId: dId,
              isCase: false
            });
          }
        }
        return finalPool;
      }

      // Full Multi-Angle Assembly: Codals + Cases + Companion Pairs
      if (activeCodalDims.length > 0 || activeReviewerDims.length > 0) {
        finalPool.push(...rawCodalTopics);
      }

      if (activeSingleCaseDims.length > 0) {
        finalPool.push(...caseItems);
      }

      if (hasDualCaseDim && caseItems.length >= 2) {
        const onlyDualSelected = activeSingleCaseDims.length === 0 && activeCodalDims.length === 0 && activeReviewerDims.length === 0;
        const pairedCases = buildCompanionCasePairs(caseItems, onlyDualSelected);
        if (onlyDualSelected) {
          return pairedCases;
        }
        finalPool.push(...pairedCases);
      } else if (hasDualCaseDim && caseItems.length === 1 && finalPool.length === 0) {
        finalPool.push({ ...caseItems[0], forcedDimensionId: 7 });
      }

      return finalPool;
    }

    function assignDimensionToItem(item, index) {
      if (item.forcedDimensionId && DIMENSIONS_REGISTRY[item.forcedDimensionId]) {
        return DIMENSIONS_REGISTRY[item.forcedDimensionId];
      }

      const activeIds = state.activeDimensions.length > 0 ? state.activeDimensions : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      if (item.isDualPair) {
        return DIMENSIONS_REGISTRY[8];
      }

      const caseDimIds = activeIds.filter(id => [5, 6, 7].includes(id));

      if (item.isCase) {
        if (caseDimIds.length > 0) {
          const chosenId = caseDimIds[index % caseDimIds.length];
          return DIMENSIONS_REGISTRY[chosenId];
        } else {
          // NEVER fall back to Case FIR if Case dimensions are unchecked!
          item.isCase = false;
          const chosenId = activeIds[index % activeIds.length];
          return DIMENSIONS_REGISTRY[chosenId];
        }
      } else {
        const codalRevDimIds = activeIds.filter(id => [1, 2, 3, 4, 9, 10].includes(id));
        const chosenId = codalRevDimIds.length > 0
          ? codalRevDimIds[index % codalRevDimIds.length]
          : activeIds[index % activeIds.length];
        return DIMENSIONS_REGISTRY[chosenId];
      }
    }

    function partitionIntoBatches(fullItemsList, batchSize) {
      const effectiveSize = batchSize >= 50 ? Math.max(fullItemsList.length, 1) : batchSize;
      const batches = [];
      for (let i = 0; i < fullItemsList.length; i += effectiveSize) {
        const chunk = fullItemsList.slice(i, i + effectiveSize);
        const calibrated = chunk.map((item, idx) => {
          const dimObj = assignDimensionToItem(item, idx);
          return {
            ...item,
            dimensionId: dimObj.id,
            dimensionCode: dimObj.code,
            dimension: dimObj.label,
            exportTag: dimObj.exportTag,
            schemaType: dimObj.schemaType
          };
        });
        batches.push(calibrated);
      }
      return batches;
    }

    function populateBatchDropdown(batches, batchSize) {
      const select = document.getElementById('activeBatchSelect');
      if (!select) return;
      select.innerHTML = '';
      if (!batches || batches.length === 0) {
        select.innerHTML = '<option value="0">Batch 1: 0 Cards</option>';
        return;
      }

      let runningCount = 0;
      batches.forEach((b, idx) => {
        const start = runningCount + 1;
        const end = runningCount + b.length;
        runningCount = end;
        const opt = document.createElement('option');
        opt.value = idx;
        opt.innerText = `Batch ${idx + 1} of ${batches.length}: Cards ${start}–${end} (${b.length} Cards)`;
        select.appendChild(opt);
      });
      select.selectedIndex = 0;
    }

    function onBatchSizeChanged() {
      const typedScope = document.getElementById('typedScopeInput')?.value.trim() || '';
      updateScopePreviewUI(typedScope);
    }

    function updateScopePreviewUI(val) {
      evaluateGatekeeperState();

      const drawerList = document.getElementById('verifiedQueueList');
      const badge = document.getElementById('parsedItemsCountBadge');
      const autoFillBtn = document.getElementById('autoFillUnindexedBtn');
      const unindexedCountBadge = document.getElementById('unindexedCountBadge');
      if (!drawerList) return;

      const batchSize = parseInt(document.getElementById('batchSizeSelect')?.value || '15', 10);
      const previewItems = expandDeterministicScopeItems(val);

      if (previewItems.length > 0) {
        let matchedCount = 0;
        let unindexedCases = 0;

        const rowsHtml = previewItems.map((item, i) => {
          const dimObj = assignDimensionToItem(item, i);
          let statusBadge = '';

          if (item.isDualPair) {
            const mA = findMatchingDigest(item.caseA.case_title, item.caseA.citation);
            const mB = findMatchingDigest(item.caseB.case_title, item.caseB.citation);
            if (mA && mB) {
              matchedCount++;
              statusBadge = `<span class="text-emerald-400 font-mono text-[10px] font-bold shrink-0">● Dual Digest Matched</span>`;
            } else {
              statusBadge = `<span class="text-sky-300 font-mono text-[10px] font-bold shrink-0">⚖️ Same-Topic Pair</span>`;
            }
          } else if (item.isCase) {
            const matchedDigest = findMatchingDigest(item.case_title, item.citation);
            if (matchedDigest) {
              matchedCount++;
              const dLabel = matchedDigest.grNumber ? ` [${matchedDigest.grNumber}]` : '';
              statusBadge = `<span class="text-emerald-400 font-mono text-[10px] font-bold shrink-0">● PDF Matched${escapeHtml(dLabel)}</span>`;
            } else {
              unindexedCases++;
              statusBadge = state.loadedFiles.length > 0
                ? `<span class="text-amber-400 font-mono text-[10px] font-bold shrink-0">▲ Unindexed in PDF</span>`
                : `<span class="text-sky-300 font-mono text-[10px] font-bold shrink-0">⚖️ Syllabus Case</span>`;
            }
          } else {
            const queryTarget = item.baseTopic || item.topic;
            const verbatim = retrieveVerbatimProvision(`${queryTarget} ${item.rule_citation}`);
            if (verbatim) {
              matchedCount++;
              statusBadge = `<span class="text-emerald-400 font-mono text-[10px] font-bold shrink-0">● Verbatim Codal</span>`;
            } else {
              statusBadge = `<span class="text-amber-300 font-mono text-[10px] shrink-0">§ Atomic Codal/Rule</span>`;
            }
          }

          return `
            <div class="flex items-center justify-between py-1.5 text-[11px] gap-2">
              <span class="truncate text-slate-200 font-semibold">${i + 1}. ${escapeHtml(item.topic)}</span>
              <div class="flex items-center space-x-2 shrink-0">
                <span class="text-slate-400 font-mono text-[10px] bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 max-w-[175px] truncate">${escapeHtml(dimObj.shortTag)}</span>
                ${statusBadge}
              </div>
            </div>
          `;
        }).join('');

        if (badge) {
          badge.innerText = `${previewItems.length} Atomic Cards · ${matchedCount}/${previewItems.length} Local Grounded`;
        }

        if (autoFillBtn && unindexedCountBadge) {
          if (unindexedCases > 0 && state.loadedFiles.length > 0) {
            unindexedCountBadge.innerText = unindexedCases;
            autoFillBtn.classList.remove('hidden');
          } else {
            autoFillBtn.classList.add('hidden');
          }
        }

        drawerList.innerHTML = rowsHtml;

        const batches = partitionIntoBatches(previewItems, batchSize);
        populateBatchDropdown(batches, batchSize);
        return;
      }

      if (badge) badge.innerText = "0 Items Previewed";
      if (autoFillBtn) autoFillBtn.classList.add('hidden');
      drawerList.innerHTML = `<span class="text-slate-500 italic block py-2">Specify your coverage scope above (with a Syllabus or Reference Sources attached) to preview unbundled atomic cards.</span>`;
    }

// ---------------------------------------------------------------------------
    // GEMINI API ENGINE WITH MULTI-PROJECT KEY ROTATION & CASCADE
    // ---------------------------------------------------------------------------
    function parseApiKeys(val) {
      state.apiKeys = val.split(',').map(k => k.trim()).filter(Boolean);
      state.currentKeyIndex = 0;
      updateKeyCounterBadge();
    }

    function onApiKeyChanged(val) {
      localStorage.setItem('bar_gemini_api_keys', val.trim());
      parseApiKeys(val.trim());
    }

    function updateKeyCounterBadge() {
      const total = state.apiKeys.length;
      const current = total > 0 ? state.currentKeyIndex + 1 : 0;
      document.getElementById('activeKeyBadge').innerText = `${current} of ${total}`;
      const badge = document.getElementById('keyCounterBadge');
      if (badge) badge.innerText = `${total} Key(s) Loaded`;
    }

    function getActiveApiKey() {
      return state.apiKeys[state.currentKeyIndex] || state.apiKeys[0] || '';
    }

    async function callGemini(contents, systemInstruction, responseSchema = null, modelPoolIndex = 0) {
      const totalKeys = state.apiKeys.length;
      if (totalKeys === 0) throw new Error("Please enter at least one valid Gemini API Key in Setup.");

      const MODEL_CASCADE = Array.from(new Set([
        state.selectedModel,
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.7-flash',
        'gemini-3.5-flash',
        'gemini-2.5-flash',
        'gemini-1.5-flash',
        'gemini-3.1-flash-lite'
      ]));

      const mergedContents = JSON.parse(JSON.stringify(contents));
      if (systemInstruction && mergedContents.length > 0 && mergedContents[0].parts && mergedContents[0].parts[0]) {
        const amendatoryAuditMandate = 
`[PHILIPPINE BAR EXAM REVIEW PROFESSOR — SYLLABUS FIDELITY & DOCTRINAL PROGRESSION MANDATE]:
1. ACTIVE SUBJECT WORKSPACE: ${currentSubjectName}

2. DUAL-OBLIGATION DIRECTIVE (SYLLABUS ASSIGNMENT + PREVAILING LAW):
   You are an authoritative Philippine Bar Review Director. Syllabi regularly assign historic landmark cases and foundational codals that have since been modified, superseded, or abandoned. 
   - DO NOT replace or skip the assigned topic or case. If the question asks for "Republic v. Molina", drill the facts, issue, ruling, and original guidelines of Molina.
   - DO NOT erase historic codals if assigned. If a question asks for the classic RPC provision on Statutory Rape or the old Dead Man's Statute, test the candidate on the concept assigned.

3. MANDATORY DOCTRINAL EVOLUTION BRIDGE (THE "ATTY. STANLEY" RULE):
   Whenever the assigned topic or case has been superseded, modified, abandoned, or amended by later jurisprudence or statute, you MUST include a dedicated, unmissable evolution section in both the question debrief and the benchmark breakdown:
   
   • For Jurisprudence (Overruled / Modified Precedents):
     State the assigned case's historic ruling, then provide:
     "⚠️ BAR EXAM JURISPRUDENTIAL EVOLUTION: While [Assigned Case, e.g., Republic v. CA & Molina (1997)] established [historic doctrine], this doctrine was explicitly abandoned/modified by the Supreme Court En Banc in [Prevailing Case, e.g., Tan-Andal v. Andal, G.R. No. 196359 (2021)]. Explain the precise operational difference: [e.g., Psychological incapacity is now recognized as a legal, not medical, concept; expert psychiatric testimony is no longer an absolute requisite; the totality of evidence standard now controls]."
     
   • For Statutes & Rules (Repealed / Amended Provisions):
     State the codal rule, then provide:
     "⚡ BAR EXAM AMENDATORY STATUTE ALERT: Note that under [Amending Statute, e.g., R.A. No. 11648 / R.A. No. 10951 / R.A. No. 11576 / 2019 Revised Rules on Evidence / CPRA], [Old Provision/Standard, e.g., statutory rape age threshold of 12 years old] was amended to [Current Enforceable Rule, e.g., under 16 years of age, subject to the close-in-age Romeo & Juliet exemption under Sec. 2]."

4. RECIPROCAL EVALUATION SCORING (BAR EXAM SUBSTANTIAL COMPLIANCE):
   - If the student recites the historical case/provision accurately but omits the superseding doctrine/statute: Award SATISFACTORY compliance for the assigned topic, but explicitly instruct them in Section 3 ("How to Adjust & Polish Your Delivery") that in the actual Bar Exam, citing only the old doctrine without acknowledging the prevailing amendatory ruling will cost crucial examination points.
   - If the student recites the modern prevailing rule (*Tan-Andal* or *R.A. 11648*) while discussing the older syllabus topic: Commend their modern awareness and provide the historical bridge.`;

        mergedContents[0].parts[0].text = `${amendatoryAuditMandate}\n\n[TASK INSTRUCTION]:\n${systemInstruction}\n\n---\n\n${mergedContents[0].parts[0].text}`;
      }

      const body = {
        contents: mergedContents,
        generationConfig: { temperature: 0.1 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      };

      if (responseSchema) {
        body.generationConfig.response_mime_type = "application/json";
        body.generationConfig.response_schema = responseSchema;
      }

      let currentModelIdx = modelPoolIndex;
      let lastError = null;

      while (currentModelIdx < MODEL_CASCADE.length) {
        const currentModel = MODEL_CASCADE[currentModelIdx];
        let keysTriedThisRound = 0;

        while (keysTriedThisRound < totalKeys) {
          const activeKey = getActiveApiKey();
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${activeKey}`;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(new Error("Request timed out")), 25000);

            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              const errMsg = errData.error?.message || `HTTP ${res.status}`;
              lastError = new Error(errMsg);

              if (res.status === 429 || res.status === 503) {
                keysTriedThisRound++;
                state.currentKeyIndex = (state.currentKeyIndex + 1) % totalKeys;
                updateKeyCounterBadge();
                await new Promise(r => setTimeout(r, 400));
                continue;
              }
              break;
            }

            const data = await res.json();
            const textOutput = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!textOutput) throw new Error("Empty response from AI engine.");
            return textOutput;
          } catch (err) {
            lastError = err;
            keysTriedThisRound++;
            state.currentKeyIndex = (state.currentKeyIndex + 1) % totalKeys;
            updateKeyCounterBadge();
            await new Promise(r => setTimeout(r, 400));
          }
        }
        currentModelIdx++;
      }
      throw lastError || new Error("Keys exhausted. Please check quota.");
    }

    function parseAIJson(rawText) {
      if (!rawText) throw new Error("Empty response received.");
      let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      try { return JSON.parse(cleaned); } catch (_) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error("Failed to parse clean JSON.");
      }
    }

    // ---------------------------------------------------------------------------
    // CASE-SPECIFIC DIGEST SYNTHESIZER (NO CROSS-CASE FACT REPETITION)
    // ---------------------------------------------------------------------------
    async function generateAndCacheMissingDigest(caseItem) {
      const titleStr = (caseItem.case_title || caseItem.topic || '').trim();
      const citationStr = (caseItem.citation || '').trim();
      const topicContext = (caseItem.legal_subject || currentSubjectName).trim();

      const schema = {
        type: "OBJECT",
        properties: {
          doctrine: { type: "STRING" },
          facts: { type: "STRING" },
          issue: { type: "STRING" },
          ruling: { type: "STRING" }
        },
        required: ["doctrine", "facts", "issue", "ruling"]
      };

      const prompt = [{
        role: "user",
        parts: [{
          text: `Provide the authentic Philippine Supreme Court case digest for this specific decision ONLY:
Case Title: ${titleStr}
Docket / Citation: ${citationStr || 'Philippine Supreme Court'}
Assigned Syllabus Topic: ${topicContext}

CRITICAL MANDATE:
1. Write the authentic facts, issue, ruling, and doctrine strictly for ${titleStr} (${citationStr}).
2. DO NOT substitute or reuse facts from any other case (such as People v. Peña, People v. Apostol, People v. Estibal, or Naguiat).
3. Include:
   - doctrine: Controlling legal principle under ${topicContext}.
   - facts: Authentic material operative facts, parties, and lower court posture of ${titleStr}.
   - issue: Precise legal issue resolved in ${titleStr}.
   - ruling: Categorical disposition (YES/NO) and ratio decidendi of ${titleStr}.`
        }]
      }];

      const rawJson = await callGemini(prompt, "You are an authoritative Philippine Supreme Court Case Digest compiler. Never conflate or reuse facts across different cases.", schema);
      const parsed = parseAIJson(rawJson);

      const docketId = extractDocketId(titleStr + ' ' + citationStr);
      const { p1Tokens, p2Tokens, allTokens } = extractPartyTokens(titleStr);

      const newDigest = {
        id: `${currentSubjectName}_digest_ai_${docketId || cleanAlphanumeric(titleStr)}_${Date.now()}`,
        subject: currentSubjectName,
        caseTitle: titleStr,
        cleanTitle: cleanAlphanumeric(titleStr),
        citation: citationStr,
        grNumber: docketId,
        p1Tokens,
        p2Tokens,
        allTokens,
        doctrine: sanitizeDigestSectionText(parsed.doctrine || '', false),
        facts: sanitizeDigestSectionText(parsed.facts || '', true),
        issue: sanitizeDigestSectionText(parsed.issue || '', false),
        ruling: sanitizeDigestSectionText(parsed.ruling || '', false)
      };

      state.parsedDigests.push(newDigest);
      await dbSave('digests', newDigest);
      return newDigest;
    }

    async function autoFillUnindexedCases() {
      const scopeVal = document.getElementById('typedScopeInput')?.value || '';
      const cases = parseSyllabusCases(scopeVal);
      const unindexed = cases.filter(c => !findMatchingDigest(c.case_title, c.citation));

      if (unindexed.length === 0) {
        alert("All cases in scope are already matched!");
        return;
      }
      if (state.apiKeys.length === 0) {
        alert("Please enter at least one valid Gemini API Key first.");
        return;
      }

      const btn = document.getElementById('autoFillUnindexedBtn');
      const originalHtml = btn.innerHTML;
      btn.disabled = true;

      let filled = 0;
      for (let i = 0; i < unindexed.length; i++) {
        const item = unindexed[i];
        btn.innerText = `⏳ Generating ${i + 1}/${unindexed.length}: ${item.case_title.substring(0, 20)}...`;
        try {
          await generateAndCacheMissingDigest(item);
          filled++;
          updateScopePreviewUI(scopeVal);
        } catch (err) {
          console.warn("Failed to auto-fill:", item.case_title, err);
        }
      }

      btn.disabled = false;
      btn.innerHTML = originalHtml;
      updateScopePreviewUI(scopeVal);
      renderSourcesList();
      alert(`Auto-filled and cached ${filled} of ${unindexed.length} unindexed cases into local storage!`);
    }

    // ---------------------------------------------------------------------------
    // STRICT SCOPE UNBUNDLER & ATOMIC POLYMORPHIC QUESTION GENERATOR
    // ---------------------------------------------------------------------------
    async function extractStructuredAgenda(syllabusText, scopeText, batchSize = 15) {
      const isUncapped = batchSize >= 50;
      const isExplicitRange = /(?:Rule\s*\d+[,:\s]+)?(?:Sections?|Secs?\.?|Articles?|Arts?\.?)\s*\d+\s*(?:[-–—]|to|through)\s*\d+\b/i.test(scopeText);
      const localItems = expandDeterministicScopeItems(scopeText);

      // 1. Return deterministic items if:
      // (a) An explicit range was entered, OR
      // (b) Cases were found, OR
      // (c) At least 4 distinct items were already unbundled (e.g. special rule registry or sub-provisions)
      // This prevents a single broad topic (e.g. "Rules on DNA Evidence" or "Weight of Evidence") from getting stuck as 1 card when uncapped.
      if (isExplicitRange || localItems.some(i => i.isCase || i.isDualPair) || localItems.length >= 4) {
        return localItems;
      }

      // 2. Dynamic Natural Buffer Calculation (15% buffer over natural sub-provisions instead of arbitrary 50-card jump)
      const naturalTargetCount = isUncapped
        ? Math.max(15, Math.min(35, Math.ceil((localItems.length || 15) * 1.2)))
        : batchSize;

      const sourceExcerpts = state.loadedFiles.length > 0 ? retrieveRelevantExcerpts(scopeText, 4500) : "";
      const activeIds = state.activeDimensions.length > 0 ? state.activeDimensions : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const activeLabels = activeIds.map(id => DIMENSIONS_REGISTRY[id]?.label).join('; ');
      const wantsCases = activeIds.some(id => [5, 6, 7, 8].includes(id));

      const agendaSchema = {
        type: "OBJECT",
        properties: {
          agenda: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                topic: { type: "STRING" },
                rule_citation: { type: "STRING" },
                is_case: { type: "BOOLEAN" }
              },
              required: ["topic", "rule_citation", "is_case"]
            }
          }
        },
        required: ["agenda"]
      };

      const prompt = [{
        role: "user",
        parts: [{
          text: `[WORKSPACE SUBJECT]: ${currentSubjectName}
[OPERATING PIPELINE]: ${state.operatingPipeline}
[ACTIVE RECITATION DIMENSIONS]: ${activeLabels}
[TARGET COVERAGE SCOPE (STRICT BOUNDARY)]:
${scopeText}

${sourceExcerpts ? `[UPLOADED REFERENCE SOURCE EXCERPTS]:\n${sourceExcerpts}\n` : ''}

TASK: Decompose the [TARGET COVERAGE SCOPE] into an EXHAUSTIVE, NON-REPETITIVE set of ${naturalTargetCount} distinct atomic recitation flashcards tailored strictly to the active recitation dimensions.
CRITICAL RULES:
1. STRICT SCOPE ISOLATION: Restrict your items STRICTLY AND EXCLUSIVELY to the provisions and topics inside [TARGET COVERAGE SCOPE]. DO NOT pull topics from earlier or later modules of the syllabus!
2. ${wantsCases ? "Because Case FIR dimensions are active, isolate each cited Supreme Court case in scope as a standalone item (is_case: true)." : "CASE SUPPRESSION MANDATE: Because NO Case FIR dimensions are active, DO NOT generate case recitation items! Set is_case: false on EVERY item and decompose the scope into granular statutory provisions, definitions, numbered requisites, and statutory/jurisprudential exceptions."}
3. ZERO DUPLICATION: Every item must test a distinct provision, requisite set, exception, or precedent.
Output clean JSON.`
        }]
      }];

      try {
        const rawJson = await callGemini(prompt, "Extract clean JSON recitation agenda strictly within the user's target scope.", agendaSchema);
        const parsed = parseAIJson(rawJson);
        if (parsed.agenda && parsed.agenda.length > 0) {
          const out = parsed.agenda.map(a => ({
            topic: a.topic,
            case_title: (wantsCases && a.is_case) ? a.topic : undefined,
            legal_subject: a.rule_citation,
            rule_citation: sanitizeCitation(a.rule_citation),
            isCase: Boolean(wantsCases && a.is_case)
          }));
          if (activeIds.includes(8) && out.filter(x => x.isCase).length >= 2) {
            const pairs = buildCompanionCasePairs(out.filter(x => x.isCase), false);
            out.push(...pairs);
          }
          return out;
        }
      } catch (e) {
        console.warn("AI agenda fallback:", e);
      }

      return localItems.length > 0 ? localItems : expandDeterministicScopeItems("Rule 130 Section 37-50");
    }

    async function generateQuestionPackage(item, qNum, totalCount) {
      const dimObj = DIMENSIONS_REGISTRY[item.dimensionId] || assignDimensionToItem(item, qNum - 1);
      const schemaType = dimObj.schemaType;

      // 1. DUAL-CASE COMPARATIVE SYNTHESIS (DIMENSION 8)
      if (schemaType === 'COMPARATIVE_FIR') {
        const titleA = item.caseA ? item.caseA.case_title : item.topic.split(/\s+vs?\.\s+/i)[0];
        const titleB = item.caseB ? item.caseB.case_title : (item.topic.split(/\s+vs?\.\s+/i)[1] || "its companion precedent");

        let dA = item.caseA ? findMatchingDigest(item.caseA.case_title, item.caseA.citation) : findMatchingDigest(titleA);
        let dB = item.caseB ? findMatchingDigest(item.caseB.case_title, item.caseB.citation) : findMatchingDigest(titleB);

        const contextParts = [];
        if (dA) contextParts.push(`[CASE A DIGEST - ${dA.caseTitle}]:\nFacts: ${dA.facts}\nIssue: ${dA.issue}\nRuling: ${dA.ruling}\nDoctrine: ${dA.doctrine}`);
        if (dB) contextParts.push(`[CASE B DIGEST - ${dB.caseTitle}]:\nFacts: ${dB.facts}\nIssue: ${dB.issue}\nRuling: ${dB.ruling}\nDoctrine: ${dB.doctrine}`);

        const compSchema = {
          type: "OBJECT",
          properties: {
            question_text: { type: "STRING" },
            benchmark_comparative: {
              type: "OBJECT",
              properties: {
                case_a_summary: { type: "STRING" },
                case_b_summary: { type: "STRING" },
                comparative_synthesis: { type: "STRING" }
              },
              required: ["case_a_summary", "case_b_summary", "comparative_synthesis"]
            }
          },
          required: ["question_text", "benchmark_comparative"]
        };

        const prompt = [{
          role: "user",
          parts: [{
            text: `[COMPARATIVE PRECEDENT SYNTHESIS - DIMENSION 8]:
Subject: ${currentSubjectName}
Case A: ${titleA}
Case B: ${titleB}
Assigned Syllabus Topic: ${item.legal_subject || item.rule_citation || currentSubjectName}

${contextParts.join('\n\n') || 'Rely on authentic Philippine Supreme Court jurisprudence.'}

TASK:
1. Formulate a direct Socratic oral recitation call requiring the student to state and compare the operative facts, legal issues, and Supreme Court rulings in BOTH ${titleA} and ${titleB} under ${item.legal_subject || currentSubjectName}, and explain why the Court ruled as it did in each case.
2. In benchmark_comparative:
   - case_a_summary: Complete FIR brief (Facts, Issue, Ruling) of ${titleA}.
   - case_b_summary: Complete FIR brief (Facts, Issue, Ruling) of ${titleB}.
   - comparative_synthesis: A single unified comparative analysis in structured prose explaining the doctrinal harmony or factual hinge distinguishing the two precedents.`
          }]
        }];

        const rawJson = await callGemini(prompt, "You are a Philippine Law Professor conducting a comparative case recitation.", compSchema);
        const parsedComp = parseAIJson(rawJson);
        if (parsedComp && parsedComp.question_text) {
          parsedComp.question_text = sanitizeQuestionPrompt(parsedComp.question_text);
        }
        return parsedComp;
      }

      // 2. SINGLE CASE FIR ARCHETYPES (DIMENSIONS 5, 6, 7)
      if (schemaType === 'FIR') {
        const caseTitle = item.case_title || item.topic;
        const citationTag = item.citation ? ` (${item.citation})` : '';
        let digest = findMatchingDigest(caseTitle, item.citation);

        if (!digest && state.apiKeys.length > 0) {
          digest = await generateAndCacheMissingDigest({
            case_title: caseTitle,
            citation: item.citation || '',
            legal_subject: item.legal_subject || currentSubjectName
          });
        }

        let qText = "";
        if (dimObj.id === 5) {
          qText = `Counsel, in the case of ${caseTitle}${citationTag} under ${item.legal_subject || currentSubjectName}, state the material operative facts that gave rise to the dispute, the parties involved, and the procedural posture by which the controversy reached the Supreme Court.`;
        } else if (dimObj.id === 6) {
          qText = `Counsel, in the case of ${caseTitle}${citationTag} under ${item.legal_subject || currentSubjectName}, what was the precise legal issue resolved by the Supreme Court, how did the Court rule, and what controlling doctrine or legal test was established?`;
        } else {
          qText = `Counsel, recite the case of ${caseTitle}${citationTag} as assigned under ${item.legal_subject || currentSubjectName}.\n\nState the material operative facts, the precise legal issue resolved by the Supreme Court, and the Court's controlling ruling and ratio decidendi.`;
        }

        if (digest && (digest.facts || digest.ruling)) {
          return {
            question_text: sanitizeQuestionPrompt(qText),
            benchmark_fir: {
              facts: digest.facts,
              issue: digest.issue,
              ruling: digest.ruling,
              ratio_doctrine: digest.doctrine || digest.ruling
            },
            isGrounded: true
          };
        }
      }

      // 3. ATOMIC CODAL & STATUTORY ARCHETYPES (DIMENSIONS 1, 2, 3 — STRICT ISOLATION)
      if (schemaType === 'CODAL') {
        const cleanTopicName = item.baseTopic || item.topic;
        const excerpts = retrieveRelevantExcerpts(`${item.rule_citation} ${cleanTopicName}`, 3000);
        const verbatim = retrieveVerbatimProvision(`${item.rule_citation} ${cleanTopicName}`);

        const codalSchema = {
          type: "OBJECT",
          properties: {
            question_text: { type: "STRING" },
            benchmark_codal_breakdown: {
              type: "OBJECT",
              properties: {
                operative_rule_summary: { type: "STRING" },
                elements_requisites: { type: "STRING" },
                statutory_exceptions: { type: "STRING" },
                jurisprudential_exceptions: { type: "STRING" },
                application_ratio: { type: "STRING" }
              },
              required: ["operative_rule_summary", "elements_requisites", "statutory_exceptions", "jurisprudential_exceptions", "application_ratio"]
            }
          },
          required: ["question_text", "benchmark_codal_breakdown"]
        };

        let atomicDirective = "";
        if (dimObj.id === 1) {
          atomicDirective = `[ATOMIC DIMENSION 1 — LEGAL DEFINITION, NATURE & POLICY ONLY]:
Formulate a realistic Philippine CPALE Board Exam Multiple-Choice Question (complete with 4 distinct choices: A., B., C., and D., plus a step-by-step peso computation or standard rationale in the benchmark) asking the candidate to analyze "${cleanTopicName}" (${item.rule_citation || ''}), state its verbatim statutory rule/nature, and explain the underlying legal policy behind it.
STRICT PROHIBITION: DO NOT ask the student to enumerate requisites or list exceptions in this question! Keep the question strictly focused on Definition, Nature, and Policy.`;
        } else if (dimObj.id === 2) {
          atomicDirective = `[ATOMIC DIMENSION 2 — ESSENTIAL ELEMENTS & NUMBERED REQUISITES ONLY]:
Formulate a realistic Philippine CPALE Board Exam Multiple-Choice Question (complete with 4 distinct choices: A., B., C., and D., including Statement I / Statement II true-false traps where appropriate) testing the mandatory statutory and doctrinal elements/requisites of "${cleanTopicName}" (${item.rule_citation || ''}).
STRICT PROHIBITION: DO NOT ask the student to define the concept or list its exceptions in this question! Demand ONLY the numbered enumeration of essential elements/requisites.`;
        } else {
          atomicDirective = `[ATOMIC DIMENSION 3 — STATUTORY PROVISOS & JURISPRUDENTIAL EXCEPTIONS ONLY]:
Formulate a realistic Philippine CPALE Board Exam Multiple-Choice Question (complete with 4 distinct choices: A., B., C., and D.) testing exceptions, journal entry effects, or procedural/statutory rules on the recognized exceptions, negative qualifications, express statutory provisos, and landmark Supreme Court case-law exceptions to "${cleanTopicName}" (${item.rule_citation || ''}).
STRICT PROHIBITION: DO NOT ask for the general definition or standard elements! Ask ONLY for the statutory exceptions/provisos and jurisprudential exceptions/qualifications.`;
        }

        const prompt = [{
          role: "user",
          parts: [{
            text: `[CODAL RECITATION CARD ${qNum} OF ${totalCount}]:
Subject: ${currentSubjectName}
Provision / Topic: ${cleanTopicName} (${item.rule_citation || ''})
Active Dimension: ${dimObj.label}

${verbatim ? `[VERBATIM CANONICAL STATUTORY BENCHMARK]:\n${verbatim}\n` : ''}
${excerpts ? `[SOURCE EXCERPTS]:\n${excerpts}\n` : ''}

${atomicDirective}

CRITICAL ANTI-TRUNCATION MANDATE (PHASE 6):
1. In operative_rule_summary: State the complete operative statutory provision. If the rule contains enumerated factors or subsections (such as Rule 133 Sec. 5 factors [a] through [e]), YOU MUST STATE ALL FACTORS IN FULL. NEVER cut off sentences with colons (:), dashes (-), or "for that purpose may consider the following:".
2. In elements_requisites: Enumerate all mandatory requisites strictly using numbered markers: (1), (2), (3)...
3. In statutory_exceptions: Enumerate all express statutory exceptions or provisos using numbered markers: (1), (2)...
4. In jurisprudential_exceptions: Enumerate controlling Supreme Court doctrinal exceptions or qualifications.
5. In application_ratio: Explain the complete policy ratio behind the rule.`
          }]
        }];

        const rawJson = await callGemini(prompt, "You are an authoritative Philippine Bar Examiner formulating complete, non-truncated codal benchmarks.", codalSchema);
        const parsed = parseAIJson(rawJson);

        // Auto-heal truncation using local canonical registry if AI cut off mid-list
        parsed.codal_provision_text = verbatim || healTruncatedStatutoryText(parsed.benchmark_codal_breakdown.operative_rule_summary, cleanTopicName);
        parsed.benchmark_codal_breakdown.operative_rule_summary = healTruncatedStatutoryText(parsed.benchmark_codal_breakdown.operative_rule_summary, cleanTopicName);
        if (parsed.question_text) {
          parsed.question_text = sanitizeQuestionPrompt(parsed.question_text);
        }
        return parsed;
      }

      // 4. REVIEWER, DISTINCTIONS, HYPOTHETICALS & REMEDIES (DIMENSIONS 4, 9, 10 — STRICT 4-PART ALAC)
      const cleanTopicName = item.baseTopic || item.topic;
      const excerpts = retrieveRelevantExcerpts(`${cleanTopicName} ${item.rule_citation}`, 3200);
      const verbatimBasis = retrieveVerbatimProvision(`${cleanTopicName} ${item.rule_citation}`);

      const alacSchema = {
        type: "OBJECT",
        properties: {
          question_text: { type: "STRING" },
          benchmark_alac: {
            type: "OBJECT",
            properties: {
              p1_direct_answer: { type: "STRING" },
              p2_legal_basis: { type: "STRING" },
              p3_analysis: { type: "STRING" },
              p4_conclusion: { type: "STRING" }
            },
            required: ["p1_direct_answer", "p2_legal_basis", "p3_analysis", "p4_conclusion"]
          }
        },
        required: ["question_text", "benchmark_alac"]
      };

      let reviewerDirective = "";
      if (dimObj.id === 4) {
        reviewerDirective = `Demand a structured point-by-point doctrinal distinction contrasting "${cleanTopicName}" with its closest legal counterpart under Philippine law. In p3_analysis, write structured comparative paragraphs (DO NOT use Markdown tables).`;
      } else if (dimObj.id === 9) {
        reviewerDirective = `Present a realistic Philippine CPALE Board Examination situational MCQ (complete with 4 distinct choices: A., B., C., and D.) testing "${cleanTopicName}" (${item.rule_citation || ''}). Require a comprehensive 4-part ALAC resolution.`;
      } else {
        reviewerDirective = `Interrogate strictly on the proper procedural remedy, vehicle, prescriptive period, waiver effect, or jurisdictional bar governing "${cleanTopicName}" (${item.rule_citation || ''}).`;
      }

      const prompt = [{
        role: "user",
        parts: [{
          text: `[BAR REVIEWER RECITATION CARD ${qNum} OF ${totalCount}]:
Subject: ${currentSubjectName}
Topic / Precedent: ${cleanTopicName} (${item.rule_citation || ''})
Active Dimension: ${dimObj.label}

${verbatimBasis ? `[VERBATIM CANONICAL STATUTE FOR LEGAL BASIS]:\n${verbatimBasis}\n` : ''}
${excerpts ? `[SOURCE EXCERPTS]:\n${excerpts}\n` : ''}

MANDATORY DIRECTIVES:
1. ${reviewerDirective}

STRICT 4-PART ALAC INTEGRITY STANDARD (PHASE 6):
In benchmark_alac:
- p1_direct_answer: EXACTLY ONE unequivocal, categorical ruling sentence answering the call directly (e.g., "No, the plaintiff's objection is not meritorious.", "Yes, the motion to quash must be granted.", "The accused is liable for Murder.").
- p2_legal_basis: MUST state the exact governing legal citation (statute, rule number, or landmark precedent) AND recite the full substantive legal rule/elements/test. 
  *** STRICT PROHIBITION: A bare citation line (e.g. 'Rule 133, Section 7 of the Rules on Evidence' or 'Article 1156 of the Civil Code') WITHOUT reciting the operative rule itself is STRICTLY FORBIDDEN. You must recite the governing rule (e.g., 'Under Rule 133, Section 7 of the 2019 Revised Rules on Evidence, the court may stop the introduction of further testimony upon any particular point when the evidence upon it is already so full that more witnesses to the same point cannot be reasonably expected to be additionally persuasive. But this power should be exercised with caution.'). ***
- p3_analysis: Systematically pair the operative facts of the problem scenario with each requisite of the legal basis.
- p4_conclusion: A definitive final concluding sentence that directly disposes of the controversy.`
        }]
      }];

      const rawJson = await callGemini(prompt, `You are a Philippine Bar Examiner in ${currentSubjectName} enforcing strict 4-part ALAC compliance.`, alacSchema);
      const parsed = parseAIJson(rawJson);

      // Auto-heal ALAC Legal Basis if AI omitted the substantive rule text
      if (parsed.benchmark_alac && parsed.benchmark_alac.p2_legal_basis) {
        parsed.benchmark_alac.p2_legal_basis = healTruncatedAlacBasis(parsed.benchmark_alac.p2_legal_basis, verbatimBasis || cleanTopicName);
      }
      if (parsed.question_text) {
        parsed.question_text = sanitizeQuestionPrompt(parsed.question_text);
      }
      return parsed;
    }

    // ---------------------------------------------------------------------------
    // ACTIVE RECITATION SESSION & CARD LAUNCHER
    // ---------------------------------------------------------------------------
    function setLifelineText(item) {
      const contentEl = document.getElementById('lifelineContent');
      if (!contentEl) return;

      if (item.isDualPair && item.caseA && item.caseB) {
        const dA = findMatchingDigest(item.caseA.case_title, item.caseA.citation);
        const dB = findMatchingDigest(item.caseB.case_title, item.caseB.citation);
        if (dA || dB) {
          contentEl.innerHTML = `
            <div class="space-y-3">
              ${dA ? `<div><b class="text-sky-400 font-mono uppercase block mb-1">■ ${escapeHtml(dA.caseTitle)}:</b><div class="text-slate-300">${formatBenchmarkText(dA.doctrine || dA.facts, false)}</div></div>` : ''}
              ${dB ? `<div class="pt-2 border-t border-slate-800"><b class="text-amber-400 font-mono uppercase block mb-1">■ ${escapeHtml(dB.caseTitle)}:</b><div class="text-slate-300">${formatBenchmarkText(dB.doctrine || dB.facts, false)}</div></div>` : ''}
            </div>
          `;
        } else {
          contentEl.innerHTML = `<span class="text-slate-400 italic">Dual companion cases queued for comparative synthesis.</span>`;
        }
      } else if (item.isCase) {
        const digest = findMatchingDigest(item.case_title || item.topic, item.citation);
        if (digest && (digest.facts || digest.doctrine)) {
          contentEl.innerHTML = `
            <div class="space-y-3">
              <div><b class="text-emerald-400 font-mono text-[11px] uppercase block mb-1">■ Controlling Doctrine:</b><div class="text-emerald-200">${formatBenchmarkText(digest.doctrine, false)}</div></div>
              <div class="pt-2 border-t border-slate-800"><b class="text-amber-400 font-mono text-[11px] uppercase block mb-1">■ Operative Facts:</b><div class="text-slate-300">${formatBenchmarkText(digest.facts, false)}</div></div>
            </div>
          `;
        } else {
          contentEl.innerHTML = `<span class="text-amber-400 font-mono">Case excerpt will be synthesized and cached into the Master DB upon evaluation.</span>`;
        }
      } else {
        const queryTarget = item.baseTopic || item.topic;
        const excerpt = retrieveRelevantExcerpts(`${queryTarget} ${item.rule_citation}`, 1800);
        if (excerpt) {
          contentEl.innerHTML = `<div class="space-y-2 text-slate-200">${formatBenchmarkText(excerpt, false)}</div>`;
        } else {
          const conc = checkConcordanceNote(`${queryTarget} ${item.rule_citation}`);
          contentEl.innerHTML = conc ? `<div class="text-amber-300 font-mono">${escapeHtml(conc)}</div>` : `<span class="text-slate-400 italic">Relying on syllabus & statutory registry.</span>`;
        }
      }

      document.getElementById('codalLifelineDrawer').classList.add('hidden');
      document.getElementById('lifelineChevron').innerText = "▼";
      state.isAssisted = false;
    }

    function toggleCodalLifeline() {
      const drawer = document.getElementById('codalLifelineDrawer');
      const chevron = document.getElementById('lifelineChevron');
      const isHidden = drawer.classList.contains('hidden');
      if (isHidden) {
        drawer.classList.remove('hidden');
        chevron.innerText = "▲";
        state.isAssisted = true;
      } else {
        drawer.classList.add('hidden');
        chevron.innerText = "▼";
      }
    }

    function triggerPrefetch(nextIdx) {
      if (nextIdx >= state.totalQuestions || nextIdx >= state.activeAgenda.length) {
        state.prefetchPromise = null;
        state.prefetchedNextQuestion = null;
        return;
      }
      const nextItem = state.activeAgenda[nextIdx];
      if (nextItem.question_text && (nextItem.benchmark_fir || nextItem.benchmark_codal_breakdown || nextItem.benchmark_alac || nextItem.benchmark_comparative)) {
        state.prefetchPromise = null;
        state.prefetchedNextQuestion = { index: nextIdx + 1, item: nextItem, pkg: nextItem };
        return;
      }
      state.prefetchPromise = generateQuestionPackage(nextItem, nextIdx + 1, state.totalQuestions)
        .then(pkg => {
          state.prefetchedNextQuestion = { index: nextIdx + 1, item: nextItem, pkg };
          return state.prefetchedNextQuestion;
        })
        .catch(() => {
          state.prefetchedNextQuestion = null;
          state.prefetchPromise = null;
        });
    }

    async function launchActiveCard(qIndex) {
      state.currentQuestionIndex = qIndex;

      // Part 4A-1: Auto-save active session state to localStorage
      try {
        const sessionSnapshot = {
          subject: currentSubjectName,
          activeAgenda: state.activeAgenda,
          currentQuestionIndex: qIndex,
          activeBatchIdx: state.activeBatchIdx,
          totalQuestions: state.totalQuestions,
          timestamp: Date.now()
        };
        localStorage.setItem(`bar_active_session_${currentSubjectName}`, JSON.stringify(sessionSnapshot));
      } catch (err) {
        console.warn("Could not save active session state:", err);
      }

      // Part 4A-1: Auto-save active session state to localStorage
      try {
        const sessionSnapshot = {
          subject: currentSubjectName,
          activeAgenda: state.activeAgenda,
          currentQuestionIndex: qIndex,
          activeBatchIdx: state.activeBatchIdx,
          totalQuestions: state.totalQuestions,
          timestamp: Date.now()
        };
        localStorage.setItem(`bar_active_session_${currentSubjectName}`, JSON.stringify(sessionSnapshot));
      } catch (err) {
        console.warn("Could not save active session state:", err);
      }
      document.getElementById('currentQNum').innerText = qIndex;
      const currentItem = state.activeAgenda[qIndex - 1];
      state.activeCardItem = currentItem;
      state.activeTopicName = currentItem.topic || currentItem.case_title;

      const dimObj = DIMENSIONS_REGISTRY[currentItem.dimensionId] || assignDimensionToItem(currentItem, qIndex - 1);
      currentItem.dimensionId = dimObj.id;
      currentItem.exportTag = dimObj.exportTag;
      currentItem.schemaType = dimObj.schemaType;

      const ansPad = document.getElementById('studentAnswer');
      const ansLabel = document.getElementById('answerPadLabel');
      if (ansPad && dimObj.placeholder) ansPad.placeholder = dimObj.placeholder;
      if (ansLabel) ansLabel.innerText = `CPALE Board Answer Pad — ${dimObj.shortTag}`;

      const concNote = checkConcordanceNote(currentItem.baseTopic || currentItem.topic) || checkConcordanceNote(currentItem.rule_citation);
      const concBox = document.getElementById('concordanceAlertBox');
      const concText = document.getElementById('concordanceAlertText');
      if (concNote && !currentItem.isCase) {
        concBox.classList.remove('hidden');
        concText.innerText = concNote;
      } else {
        concBox.classList.add('hidden');
      }

      document.getElementById('activeTopicBadge').classList.remove('hidden');
      document.getElementById('activeTopicKindLabel').innerText = currentItem.isDualPair ? "Comparative Pair:" : (currentItem.isCase ? "Case:" : "Provision / Topic:");
      document.getElementById('activeTopicName').innerText = `${state.activeTopicName} (${currentItem.rule_citation || currentItem.legal_subject || currentSubjectName})`;

      const requeueTag = currentItem.isLeitnerRequeue ? " · [RE-TEST]" : "";
      document.getElementById('questionTag').innerText = `Card ${qIndex}/${state.totalQuestions} · ${dimObj.shortTag}${requeueTag}`;

      setLifelineText(currentItem);

      document.getElementById('questionContainer').innerHTML = `<span class="text-amber-400 font-mono animate-pulse">Loading Card ${qIndex} (${dimObj.shortTag})...</span>`;
      document.getElementById('studentAnswer').value = '';
      document.getElementById('submitAnswerBtn').disabled = true;

      try {
        let pkg = null;

        if (currentItem.question_text && (currentItem.benchmark_fir || currentItem.benchmark_codal_breakdown || currentItem.benchmark_alac || currentItem.benchmark_comparative)) {
          pkg = currentItem;
        } else if (state.prefetchedNextQuestion && state.prefetchedNextQuestion.index === qIndex) {
          pkg = state.prefetchedNextQuestion.pkg;
          state.prefetchedNextQuestion = null;
          state.prefetchPromise = null;
        } else if (state.prefetchPromise) {
          const res = await state.prefetchPromise;
          if (res && res.index === qIndex) {
            pkg = res.pkg;
            state.prefetchedNextQuestion = null;
            state.prefetchPromise = null;
          }
        }

        if (!pkg) {
          pkg = await generateQuestionPackage(currentItem, qIndex, state.totalQuestions);
        }

        state.currentQuestionText = sanitizeQuestionPrompt(pkg.question_text || currentItem.question_text || '');
        state.currentBenchmarkPayload = pkg;

        const cardRecord = {
          ...currentItem,
          question_text: pkg.question_text,
          benchmark_fir: pkg.benchmark_fir || null,
          benchmark_codal_breakdown: pkg.benchmark_codal_breakdown || null,
          benchmark_alac: pkg.benchmark_alac || null,
          benchmark_comparative: pkg.benchmark_comparative || null,
          codal_provision_text: pkg.codal_provision_text || currentItem.codal_provision_text || ''
        };

        const cardKey = `${currentItem.topic || currentItem.case_title}::${currentItem.dimensionId || ''}`;
        const existingIdx = state.activeDeckCardsPool.findIndex(c => `${c.topic || c.case_title}::${c.dimensionId || ''}` === cardKey);
        if (existingIdx !== -1) state.activeDeckCardsPool[existingIdx] = cardRecord;
        else state.activeDeckCardsPool.push(cardRecord);

        document.getElementById('questionContainer').innerText = state.currentQuestionText;
        document.getElementById('submitAnswerBtn').disabled = false;
        document.getElementById('saveDeckHeaderBtn').classList.remove('hidden');
        updateWordCount();
        setupTimer();

        const statusTag = document.getElementById('retrievalStatusTag');
        if (statusTag) {
          statusTag.innerText = pkg.isGrounded ? "● Grounded in Local Digest / Codal (0 ms)" : `● Active: ${dimObj.shortTag}`;
        }

        triggerPrefetch(qIndex);
      } catch (err) {
        document.getElementById('questionContainer').innerHTML = `
          <div class="space-y-3">
            <span class="text-red-400 block font-mono text-xs">Error loading Card ${qIndex}: ${escapeHtml(err.message)}</span>
            <button onclick="launchActiveCard(${qIndex})" class="bg-slate-800 border border-amber-600/60 px-3 py-1.5 rounded text-amber-300 text-xs font-mono hover:bg-slate-700">Retry Card ${qIndex}</button>
          </div>
        `;
      }
    }

    async function startNewSession() {
      if (!evaluateGatekeeperState()) {
        alert("Gatekeeper Blocked: You must attach a Course Syllabus OR upload Reference Sources (or both), AND specify your Target Coverage Scope before launching.");
        return;
      }

      const rawInputKeys = document.getElementById('apiKeyInput')?.value.trim() || '';
      if (rawInputKeys && state.apiKeys.length === 0) parseApiKeys(rawInputKeys);

      const typedScope = document.getElementById('typedScopeInput')?.value.trim() || '';
      const batchSize = parseInt(document.getElementById('batchSizeSelect').value, 10) || 15;
      const timerVal = parseInt(document.getElementById('timerPresetSelect').value, 10);

      state.timerDefault = timerVal;
      toggleModal('setupModal');
      await requestScreenWakeLock();

      document.getElementById('progressDisplay').classList.remove('hidden');
      document.getElementById('currentQNum').innerText = '1';
      document.getElementById('questionContainer').innerHTML = `<span class="text-amber-400 font-mono animate-pulse">Unbundling scope under ${state.operatingPipeline} across ${state.activeDimensions.length} active dimensions...</span>`;

      try {
        state.allUnbundledPool = await extractStructuredAgenda(state.extractedSyllabusText, typedScope, batchSize);
        state.batchedSets = partitionIntoBatches(state.allUnbundledPool, batchSize);
        populateBatchDropdown(state.batchedSets, batchSize);

        const chosenBatchIdx = parseInt(document.getElementById('activeBatchSelect').value, 10) || 0;
        await launchBatch(chosenBatchIdx);
      } catch (err) {
        document.getElementById('questionContainer').innerHTML = `<span class="text-red-400 font-mono">Error: ${escapeHtml(err.message)}</span>`;
      }
    }

    async function launchBatch(batchIdx) {
      state.isSessionActive = true;
      state.activeBatchIdx = batchIdx;
      const rawBatch = [...(state.batchedSets[batchIdx] || [])];
      const shouldShuffle = document.getElementById('shuffleDeckCheckbox')?.checked;

      state.activeAgenda = shouldShuffle ? shuffleArray(rawBatch) : rawBatch;
      state.totalQuestions = state.activeAgenda.length;
      state.currentQuestionIndex = 1;
      state.sessionTranscript = [];
      state.activeDeckCardsPool = [];

      const shuffleLabel = shouldShuffle ? " · Shuffled" : "";
      document.getElementById('batchIndicatorBadge').innerText = `(Batch ${batchIdx + 1} of ${state.batchedSets.length}${shuffleLabel})`;
      document.getElementById('totalQNum').innerText = state.totalQuestions;

      await launchActiveCard(1);
    }

    // ---------------------------------------------------------------------------
    // POLYMORPHIC AI EVALUATION & SEPARATED CODAL EXCEPTION RENDERER
    // ---------------------------------------------------------------------------
    async function submitStudentAnswer() {
      const answer = document.getElementById('studentAnswer').value.trim();
      if (!answer) { alert("Please enter your recitation answer."); return; }

      const submitBtn = document.getElementById('submitAnswerBtn');
      const spinner = document.getElementById('submitSpinner');
      const btnText = document.getElementById('submitBtnText');

      submitBtn.disabled = true;
      spinner.classList.remove('hidden');
      btnText.innerText = "Evaluating...";

      const currentItem = state.activeAgenda[state.currentQuestionIndex - 1];
      const pkg = state.currentBenchmarkPayload || currentItem;

      const evalSchema = {
        type: "OBJECT",
        properties: {
          rating: { type: "STRING", enum: ["EXCELLENT", "SATISFACTORY", "DEFICIENT"] },
          critique: { type: "STRING" },
          missed_details: { type: "STRING" },
          correction_polish: { type: "STRING" }
        },
        required: ["rating", "critique", "missed_details", "correction_polish"]
      };

      const benchmarkJson = JSON.stringify(
        pkg.benchmark_comparative || pkg.benchmark_fir || pkg.benchmark_codal_breakdown || pkg.benchmark_alac || {}
      );

      const evalPrompt = [{
        role: "user",
        parts: [{
          text: `[ACTIVE RECITATION EVALUATION]:
Topic / Case: ${currentItem.topic || currentItem.case_title}
Active Dimension: ${currentItem.dimension || ''}
Question Asked: ${state.currentQuestionText}

STUDENT ANSWER:
${answer}

AUTHORITATIVE BENCHMARK:
${benchmarkJson}

TASK: Grade the student's recitation strictly on the specific dimension asked in the Question under Substantial Compliance (EXCELLENT, SATISFACTORY, DEFICIENT).
- Do not penalize the student for omitting exceptions if the question only asked for the definition or elements.
- If this is a Dual-Case Comparative Synthesis (Dimension 8), provide a single unified comparative analysis evaluating how well the student contrasted both cases.
- Output rating, critique, missed_details, and correction_polish.`
        }]
      }];

      try {
        const rawJson = await callGemini(evalPrompt, "Grade strictly under Philippine Bar & Law School Recitation substantial compliance standards.", evalSchema);
        const data = parseAIJson(rawJson);

        let deltaMsg = await updateTopicMastery(currentItem.topic || currentItem.case_title, data.rating, state.isAssisted);
        await stampSubjectModifiedTimestamp();

        if (data.rating === 'DEFICIENT') {
          const reinsertIdx = Math.min(state.activeAgenda.length, state.currentQuestionIndex + 3);
          state.activeAgenda.splice(reinsertIdx, 0, { ...currentItem, isLeitnerRequeue: true });
          state.totalQuestions = state.activeAgenda.length;
          document.getElementById('totalQNum').innerText = state.totalQuestions;
          deltaMsg += " · ⚠️ Re-queued 3 cards later (Leitner Drill)";
        }

        document.getElementById('masteryDeltaText').innerText = deltaMsg;

        state.sessionTranscript.push({
          qNum: state.currentQuestionIndex,
          topic: currentItem.topic || currentItem.case_title,
          question: state.currentQuestionText,
          studentAnswer: answer,
          rating: data.rating,
          critique: data.critique,
          payload: pkg
        });

        renderEvaluation(data);
      } catch (err) {
        alert("Evaluation failed: " + err.message);
      } finally {
        submitBtn.disabled = false;
        spinner.classList.add('hidden');
        btnText.innerText = "Submit for Evaluation";
      }
    }

    function revealInstantCramCard() {
      document.getElementById('cramSelfGradingBar').classList.remove('hidden');
      const currentItem = state.activeAgenda[state.currentQuestionIndex - 1];
      const pkg = state.currentBenchmarkPayload || currentItem;
      const studentDraft = document.getElementById('studentAnswer')?.value.trim() || "(Reviewed via Instant Cram 0 ms Mode)";

      state.sessionTranscript.push({
        qNum: state.currentQuestionIndex,
        topic: currentItem.topic || currentItem.case_title,
        question: state.currentQuestionText,
        studentAnswer: studentDraft,
        rating: "CRAM REVIEW",
        critique: "Self-graded in Instant Cram Mode.",
        payload: pkg
      });

      renderEvaluation({
        rating: "CRAM REVIEW",
        critique: "Self-grade your recitation based on statutory, factual, and doctrinal accuracy.",
        missed_details: "Verify every requisite, operative fact, and exception against the structured benchmark below.",
        correction_polish: "Deliver your conclusion and legal basis categorically."
      });
    }

    async function applyCramGrade(rating) {
      const currentItem = state.activeAgenda[state.currentQuestionIndex - 1];
      let deltaMsg = await updateTopicMastery(currentItem.topic || currentItem.case_title, rating, state.isAssisted);
      await stampSubjectModifiedTimestamp();

      if (rating === 'DEFICIENT') {
        const reinsertIdx = Math.min(state.activeAgenda.length, state.currentQuestionIndex + 3);
        state.activeAgenda.splice(reinsertIdx, 0, { ...currentItem, isLeitnerRequeue: true });
        state.totalQuestions = state.activeAgenda.length;
        document.getElementById('totalQNum').innerText = state.totalQuestions;
        deltaMsg += " · ⚠️ Re-queued 3 cards later (Leitner Spaced Drill)";
      }

      document.getElementById('masteryDeltaText').innerText = deltaMsg;
      const ratingBadge = document.getElementById('ratingBadge');
      ratingBadge.innerText = rating;
      ratingBadge.className = rating === 'EXCELLENT' ? "px-3 py-1 rounded-full text-xs font-bold font-mono tracking-wider bg-emerald-950 text-emerald-300 border border-emerald-800"
        : rating === 'SATISFACTORY' ? "px-3 py-1 rounded-full text-xs font-bold font-mono tracking-wider bg-amber-950 text-amber-300 border border-amber-800"
        : "px-3 py-1 rounded-full text-xs font-bold font-mono tracking-wider bg-red-950 text-red-300 border border-red-800";
    }

    function renderEvaluation(data) {
      const ratingBadge = document.getElementById('ratingBadge');
      const rating = (data.rating || 'SATISFACTORY').toUpperCase();
      ratingBadge.innerText = rating;
      ratingBadge.className = rating === 'EXCELLENT' ? "px-3 py-1 rounded-full text-xs font-bold font-mono tracking-wider bg-emerald-950 text-emerald-300 border border-emerald-800"
        : rating === 'SATISFACTORY' ? "px-3 py-1 rounded-full text-xs font-bold font-mono tracking-wider bg-amber-950 text-amber-300 border border-amber-800"
        : "px-3 py-1 rounded-full text-xs font-bold font-mono tracking-wider bg-red-950 text-red-300 border border-red-800";

      document.getElementById('critiqueText').innerText = data.critique || "Substantial compliance evaluated.";
      document.getElementById('missedDoctrinesText').innerText = data.missed_details || data.missed_doctrines || data.missed_facts_or_ratio || data.missed_elements_or_exceptions || "None.";
      document.getElementById('polishText').innerText = data.correction_polish || "Deliver with direct statutory and jurisprudential authority.";

      const pkg = state.currentBenchmarkPayload || state.activeCardItem || {};
      const box = document.getElementById('benchmarkAlacBox');

      if (pkg.benchmark_comparative) {
        const comp = pkg.benchmark_comparative;
        box.innerHTML = `
          <div class="space-y-4">
            <div class="p-4 bg-slate-900/90 rounded-xl border border-sky-800/60 shadow-sm">
              <span class="font-mono text-sky-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ Case 1 Brief (Facts, Issue & Ruling)</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(comp.case_a_summary, true)}</div>
            </div>
            <div class="p-4 bg-slate-900/90 rounded-xl border border-amber-700/60 shadow-sm">
              <span class="font-mono text-amber-300 text-xs uppercase block font-bold mb-2 tracking-wider">■ Case 2 Brief (Facts, Issue & Ruling)</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(comp.case_b_summary, true)}</div>
            </div>
            <div class="p-4 bg-slate-900/95 rounded-xl border border-emerald-800/60 shadow-sm">
              <span class="font-mono text-emerald-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ Unified Comparative Synthesis & Doctrinal Distinction</span>
              <div class="text-emerald-100/95 space-y-2.5">${formatBenchmarkText(comp.comparative_synthesis, false)}</div>
            </div>
          </div>
        `;
      } else if (pkg.benchmark_fir) {
        const fir = pkg.benchmark_fir;
        box.innerHTML = `
          <div class="space-y-4">
            <div class="p-4 bg-slate-900/95 rounded-xl border border-emerald-800/60 shadow-sm">
              <span class="font-mono text-emerald-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ Controlling Doctrine & Ratio Decidendi</span>
              <div class="text-emerald-100/95 space-y-2.5">${formatBenchmarkText(fir.ratio_doctrine, false)}</div>
            </div>
            <div class="p-4 bg-slate-900/70 rounded-xl border border-slate-800 shadow-sm">
              <span class="font-mono text-amber-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ Material Operative Facts</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(fir.facts, false)}</div>
            </div>
            <div class="p-4 bg-amber-950/20 rounded-xl border border-amber-700/50 shadow-sm">
              <span class="font-mono text-amber-300 text-xs uppercase block font-bold mb-2 tracking-wider">■ Legal Issue</span>
              <div class="text-amber-100 font-medium space-y-2">${formatBenchmarkText(fir.issue, false)}</div>
            </div>
            <div class="p-4 bg-slate-900/70 rounded-xl border border-slate-800 shadow-sm">
              <span class="font-mono text-sky-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ Supreme Court Ruling</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(fir.ruling, true)}</div>
            </div>
          </div>
        `;
      } else if (pkg.benchmark_codal_breakdown) {
        const b = pkg.benchmark_codal_breakdown;
        const verbatim = pkg.codal_provision_text || b.operative_rule_summary;
        box.innerHTML = `
          <div class="space-y-4">
            <div class="p-4 bg-slate-900/95 rounded-xl border border-amber-700/50 shadow-sm">
              <span class="font-mono text-amber-300 text-xs uppercase block font-bold mb-2 tracking-wider">■ 1. Verbatim Statutory Text & Operative Rule Summary</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(verbatim, false)}</div>
            </div>
            <div class="p-4 bg-slate-900/90 rounded-xl border border-emerald-800/60 shadow-sm">
              <span class="font-mono text-emerald-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ 2. Essential Elements & Requisites (Numbered Enumeration)</span>
              <div class="text-emerald-100/95 space-y-2.5">${formatBenchmarkText(b.elements_requisites, true)}</div>
            </div>
            <div class="p-4 bg-slate-900/80 rounded-xl border border-amber-800/60 shadow-sm">
              <span class="font-mono text-amber-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ 3A. Express Statutory Exceptions & Provisos</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(b.statutory_exceptions, false)}</div>
            </div>
            ${b.jurisprudential_exceptions ? `
            <div class="p-4 bg-slate-900/80 rounded-xl border border-sky-800/60 shadow-sm">
              <span class="font-mono text-sky-400 text-xs uppercase block font-bold mb-2 tracking-wider">■ 3B. Controlling Jurisprudential Exceptions & Qualifications</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(b.jurisprudential_exceptions, false)}</div>
            </div>` : ''}
            <div class="p-4 bg-slate-900/70 rounded-xl border border-slate-800 shadow-sm">
              <span class="font-mono text-slate-300 text-xs uppercase block font-bold mb-2 tracking-wider">■ 4. Legal Policy & Application Ratio</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(b.application_ratio, true)}</div>
            </div>
          </div>
        `;
      } else {
        const alac = pkg.benchmark_alac || {};
        box.innerHTML = `
          <div class="space-y-4">
            <div class="p-4 bg-slate-900/90 rounded-xl border border-emerald-800/60 shadow-sm">
              <span class="font-mono text-emerald-400 text-xs uppercase block font-bold mb-2 tracking-wider">1. Categorical Answer / Core Thesis (A)</span>
              <div class="text-emerald-100/95 font-medium space-y-2.5">${formatBenchmarkText(alac.p1_direct_answer, true)}</div>
            </div>
            <div class="p-4 bg-slate-900/75 rounded-xl border border-slate-800 shadow-sm">
              <span class="font-mono text-amber-400 text-xs uppercase block font-bold mb-2 tracking-wider">2. Legal Basis — Statutory & Jurisprudential Anchor (L)</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(alac.p2_legal_basis, false)}</div>
            </div>
            <div class="p-4 bg-slate-900/75 rounded-xl border border-slate-800 shadow-sm">
              <span class="font-mono text-amber-400 text-xs uppercase block font-bold mb-2 tracking-wider">3. Doctrinal Distinction / Factual Application (A)</span>
              <div class="text-slate-200 space-y-2.5">${formatBenchmarkText(alac.p3_analysis, false)}</div>
            </div>
            <div class="p-4 bg-slate-900/90 rounded-xl border border-slate-800 shadow-sm">
              <span class="font-mono text-sky-400 text-xs uppercase block font-bold mb-2 tracking-wider">4. Definitive Conclusion (C)</span>
              <div class="text-slate-100 font-medium space-y-2.5">${formatBenchmarkText(alac.p4_conclusion, true)}</div>
            </div>
          </div>
        `;
      }

      toggleModal('evalModal');
    }

    function closeEvaluation() {
      document.getElementById('cramSelfGradingBar').classList.add('hidden');
      toggleModal('evalModal');
    }

    async function proceedToNextQuestion() {
      closeEvaluation();
      if (state.currentQuestionIndex >= state.totalQuestions || state.currentQuestionIndex >= state.activeAgenda.length) {
        await releaseScreenWakeLock();
        state.isSessionActive = false; // Scanner resumes when batch concludes
        
        // Part 4A-2: Clear saved session since batch is finished
        localStorage.removeItem(`bar_active_session_${currentSubjectName}`);
        
        // Part 4A-2: Clear saved session since batch is finished
        localStorage.removeItem(`bar_active_session_${currentSubjectName}`);
        const hasNextBatch = state.batchedSets && state.activeBatchIdx + 1 < state.batchedSets.length;
        const nextBatchNum = state.activeBatchIdx + 2;

        document.getElementById('questionContainer').innerHTML = `
          <div class="text-center py-8 space-y-4">
            <span class="text-3xl font-serif text-amber-400 block mb-2">Recitation Batch Concluded</span>
            <p class="text-slate-300 text-sm">Completed all ${state.totalQuestions} cards in Batch ${state.activeBatchIdx + 1} under Leitner spaced recall.</p>
            
            <div id="fileMetricToast" class="hidden max-w-md mx-auto p-2.5 bg-emerald-950/60 border border-emerald-800/80 rounded-lg text-xs font-mono text-emerald-300"></div>

            <div class="flex items-center justify-center flex-wrap gap-3 pt-2">
              ${hasNextBatch ? `
                <button onclick="launchBatch(${state.activeBatchIdx + 1})" class="bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold px-5 py-2.5 rounded-lg text-xs shadow transition flex items-center space-x-1.5">
                  <span>Proceed to Batch ${nextBatchNum}</span>
                </button>
              ` : ''}
              <button onclick="revealAndShowFileMetrics()" class="bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-600/60 font-bold px-4 py-2.5 rounded-lg text-xs shadow transition flex items-center space-x-1.5 font-mono">
                <svg class="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"/></svg>
                <span>Reveal Synced JSON in Folder</span>
              </button>
              <button onclick="promptSaveCurrentRunAsDeck()" class="bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-600/60 font-bold px-4 py-2.5 rounded-lg text-xs shadow transition">Save as Reusable Deck</button>
              <button onclick="exportSessionMarkdown()" class="bg-emerald-700 hover:bg-emerald-600 text-white font-bold px-4 py-2.5 rounded-lg text-xs shadow transition">Export Study Sheet (.md)</button>
            </div>
          </div>
        `;
        document.getElementById('questionTag').innerText = "BATCH COMPLETE";
        document.getElementById('submitAnswerBtn').disabled = true;
        document.getElementById('flipCardBtn').disabled = true;
        document.getElementById('activeTopicBadge').classList.add('hidden');
        clearInterval(state.timerInterval);
        return;
      }
      await launchActiveCard(state.currentQuestionIndex + 1);
    }

    // ---------------------------------------------------------------------------
    // HARDENED BATCH PRE-COMPILER (WAKE LOCK + 0 MS MATCH + KEY ROTATION)
    // ---------------------------------------------------------------------------
    function showCompileModal(total) {
      document.getElementById('compileModal').classList.remove('hidden');
      document.getElementById('compileProgressBar').style.width = '0%';
      document.getElementById('compileProgressPercent').innerText = '0%';
      document.getElementById('compileCardCounter').innerText = `Card 0 of ${total}`;
      document.getElementById('compileCurrentTopic').innerText = 'Initializing universal hybrid compiler...';
      isCompilingActive = true;
    }

    function hideCompileModal() {
      document.getElementById('compileModal').classList.add('hidden');
      isCompilingActive = false;
    }

    function stopBatchCompilation() {
      if (confirm("Stop compilation? Any cards synthesized so far will be saved into your deck.")) {
        isCompilingActive = false;
      }
    }

    async function startBatchCompilationFromScope() {
      if (!evaluateGatekeeperState()) {
        alert("Gatekeeper Blocked: Please attach a Course Syllabus OR upload Reference Sources (or both), AND specify your Target Coverage Scope before pre-compiling.");
        return;
      }

      const rawInputKeys = document.getElementById('apiKeyInput')?.value.trim() || '';
      if (rawInputKeys && state.apiKeys.length === 0) parseApiKeys(rawInputKeys);

      const typedScope = document.getElementById('typedScopeInput')?.value.trim() || '';
      const batchSize = parseInt(document.getElementById('batchSizeSelect').value, 10) || 15;

      const rawItems = await extractStructuredAgenda(state.extractedSyllabusText, typedScope, batchSize);
      if (!rawItems || rawItems.length === 0) {
        alert("No coverage items found to compile. Enter section ranges, topics, or cases in Scope.");
        return;
      }

      const calibratedItems = rawItems.map((item, idx) => {
        const dimObj = assignDimensionToItem(item, idx);
        return {
          ...item,
          dimensionId: dimObj.id,
          dimensionCode: dimObj.code,
          dimension: dimObj.label,
          exportTag: dimObj.exportTag,
          schemaType: dimObj.schemaType
        };
      });

      await requestScreenWakeLock();
      // Hide setup modal so compiler progress takes full view
      document.getElementById('setupModal')?.classList.add('hidden');
      showCompileModal(calibratedItems.length);
      const compiledCards = [];
      const total = calibratedItems.length;

      for (let i = 0; i < total; i++) {
        if (!isCompilingActive) break;

        const item = calibratedItems[i];
        const cardNum = i + 1;
        const pct = Math.round((i / total) * 100);

        document.getElementById('compileProgressBar').style.width = `${pct}%`;
        document.getElementById('compileProgressPercent').innerText = `${pct}%`;
        document.getElementById('compileCardCounter').innerText = `Card ${cardNum} of ${total}`;
        document.getElementById('compileCurrentTopic').innerText = `${item.topic || item.case_title} [${item.exportTag || item.dimension}]`;

        // Fast-path: 0 ms Local Digest Match for Single-Case FIR (Dimensions 5, 6, 7)
        if (item.schemaType === 'FIR' && !item.isDualPair) {
          const matchedDigest = findMatchingDigest(item.case_title || item.topic, item.citation);
          if (matchedDigest && (matchedDigest.facts || matchedDigest.ruling)) {
            const pkg = await generateQuestionPackage(item, cardNum, total);
            compiledCards.push({
              ...item,
              question_text: pkg.question_text,
              benchmark_fir: pkg.benchmark_fir,
              isGrounded: true
            });
            continue;
          }
        }

        if (state.apiKeys.length === 0) {
          alert("Please enter at least one valid Gemini API Key to synthesize unindexed cards.");
          hideCompileModal();
          await releaseScreenWakeLock();
          return;
        }

        let success = false;
        let attempts = 0;
        const maxAttempts = 6;

        while (!success && isCompilingActive && attempts < maxAttempts) {
          try {
            attempts++;
            const pkg = await generateQuestionPackage(item, cardNum, total);

            compiledCards.push({
              ...item,
              question_text: pkg.question_text,
              benchmark_fir: pkg.benchmark_fir || null,
              benchmark_codal_breakdown: pkg.benchmark_codal_breakdown || null,
              benchmark_alac: pkg.benchmark_alac || null,
              benchmark_comparative: pkg.benchmark_comparative || null,
              codal_provision_text: pkg.codal_provision_text || ''
            });

            success = true;

            if (state.apiKeys.length > 1) {
              state.currentKeyIndex = (state.currentKeyIndex + 1) % state.apiKeys.length;
              updateKeyCounterBadge();
            }

            const pacingMs = state.apiKeys.length >= 3 ? 1200 : (state.apiKeys.length === 2 ? 1800 : 3500);
            await new Promise(r => setTimeout(r, pacingMs));
          } catch (err) {
            if (state.apiKeys.length > 1) {
              state.currentKeyIndex = (state.currentKeyIndex + 1) % state.apiKeys.length;
              updateKeyCounterBadge();
            }

            const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('ResourceExhausted') || err.message.includes('Quota'));
            const waitSeconds = isRateLimit ? 18 : 5;

            for (let w = waitSeconds; w > 0 && isCompilingActive; w--) {
              document.getElementById('compileCurrentTopic').innerHTML = `
                <span class="text-amber-400 font-bold">⚠️ Rate limit reached on attempt ${attempts}.</span>
                <span class="text-slate-300 block text-[11px] mt-0.5">Auto-cooling & switching key... Retrying Card ${cardNum} in ${w}s (Key ${state.currentKeyIndex + 1}/${state.apiKeys.length})</span>
              `;
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }

      document.getElementById('compileProgressBar').style.width = '100%';
      document.getElementById('compileProgressPercent').innerText = '100%';
      hideCompileModal();
      await releaseScreenWakeLock();

      if (compiledCards.length === 0) return;

      // 1. SAVE IMMEDIATELY to IndexedDB so cards are NEVER lost on tab blur or cancel
      const presetTag = PRESET_PROFILES[state.activePreset] ? PRESET_PROFILES[state.activePreset].name : 'Custom Matrix';
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const defaultTitle = `${currentSubjectName} - ${presetTag} (${compiledCards.length} Cards · ${timeStr})`;
      const deckId = 'deck_' + Date.now();

      const deckObj = {
        id: deckId,
        subject: currentSubjectName,
        title: defaultTitle,
        presetTag: presetTag,
        presetKey: state.activePreset,
        activeDimensions: [...state.activeDimensions],
        createdAt: new Date().toISOString(),
        cards: compiledCards
      };

      await dbSave('decks', deckObj);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();

      // 2. Re-open setup modal so the saved deck is immediately visible in the library
      document.getElementById('setupModal')?.classList.remove('hidden');

      // 3. Optional prompt to rename; if canceled or tab is switched, deck remains safe
      const userTitle = prompt("Deck pre-compiled and saved to library! Rename title (optional):", defaultTitle);
      if (userTitle && userTitle.trim() && userTitle.trim() !== defaultTitle) {
        deckObj.title = userTitle.trim();
        await dbSave('decks', deckObj);
        await stampSubjectModifiedTimestamp();
        await renderDeckListUI();
      }
    }

    // ---------------------------------------------------------------------------
    // DECK LIBRARY & UTF-8 BOM WORD (.DOC) / MARKDOWN (.MD) EXPORTERS
    // ---------------------------------------------------------------------------
    function formatExportQuestionHeader(c, qNum) {
      let baseTitle = c.baseTopic || c.topic || c.case_title || `Card ${qNum}`;
      const dimTag = c.exportTag || (c.dimensionId && DIMENSIONS_REGISTRY[c.dimensionId]?.exportTag) || '';
      if (dimTag && !baseTitle.includes(dimTag)) {
        return `Question ${qNum}: ${baseTitle} [${dimTag}]`;
      }
      return `Question ${qNum}: ${baseTitle}`;
    }

function extractCardParagraphsForExport(c) {
      const stripBolds = (str) => (str || '').replace(/\*\*/g, '').trim();
      const ensureLabel = (label, text) => {
        if (!text) return '';
        const clean = stripBolds(text);
        return clean.toUpperCase().startsWith(label) ? clean : `${label}: ${clean}`;
      };

      const paras = [];
      const dimId = c.dimensionId || c.forcedDimensionId;

      if (c.benchmark_comparative) {
        const comp = c.benchmark_comparative;
        if (comp.case_a_summary) paras.push(ensureLabel('CASE 1 BRIEF', comp.case_a_summary));
        if (comp.case_b_summary) paras.push(ensureLabel('CASE 2 BRIEF', comp.case_b_summary));
        if (comp.comparative_synthesis) paras.push(ensureLabel('COMPARATIVE SYNTHESIS', comp.comparative_synthesis));
      } else if (c.benchmark_fir) {
        const f = c.benchmark_fir;
        if (dimId === 5) {
          // Dimension 5: Facts & Procedural Posture ONLY
          if (f.facts) paras.push(ensureLabel('OPERATIVE FACTS & PROCEDURAL POSTURE', f.facts));
        } else if (dimId === 6) {
          // Dimension 6: Holding & Ratio Decidendi ONLY
          if (f.ruling) paras.push(ensureLabel('SUPREME COURT RULING', f.ruling));
          if (f.ratio_doctrine) paras.push(ensureLabel('RATIO DECIDENDI & CONTROLLING DOCTRINE', f.ratio_doctrine));
        } else {
          // Dimension 7 or Full Brief: Facts, Issue, Ruling, Ratio
          if (f.facts) paras.push(ensureLabel('FACTS', f.facts));
          if (f.issue) paras.push(ensureLabel('ISSUE', f.issue));
          if (f.ruling) paras.push(ensureLabel('RULING', f.ruling));
          if (f.ratio_doctrine) paras.push(ensureLabel('RATIO DECIDENDI', f.ratio_doctrine));
        }
      } else if (c.benchmark_codal_breakdown) {
        const b = c.benchmark_codal_breakdown;
        if (dimId === 1) {
          if (c.codal_provision_text) paras.push(ensureLabel('STATUTORY PROVISION', c.codal_provision_text));
          else if (b.operative_rule_summary) paras.push(ensureLabel('OPERATIVE RULE', b.operative_rule_summary));
          if (b.application_ratio) paras.push(ensureLabel('POLICY & NATURE', b.application_ratio));
        } else if (dimId === 2) {
          if (b.elements_requisites) paras.push(ensureLabel('ESSENTIAL REQUISITES (NUMBERED ENUMERATION)', b.elements_requisites));
        } else if (dimId === 3) {
          if (b.statutory_exceptions) paras.push(ensureLabel('EXPRESS STATUTORY EXCEPTIONS & PROVISOS', b.statutory_exceptions));
          if (b.jurisprudential_exceptions) paras.push(ensureLabel('CONTROLLING JURISPRUDENTIAL EXCEPTIONS', b.jurisprudential_exceptions));
        } else {
          if (c.codal_provision_text) paras.push(ensureLabel('STATUTORY PROVISION', c.codal_provision_text));
          if (b.elements_requisites) paras.push(ensureLabel('ESSENTIAL REQUISITES', b.elements_requisites));
          if (b.statutory_exceptions) paras.push(ensureLabel('EXPRESS STATUTORY EXCEPTIONS & PROVISOS', b.statutory_exceptions));
          if (b.jurisprudential_exceptions) paras.push(ensureLabel('JURISPRUDENTIAL EXCEPTIONS & DOCTRINES', b.jurisprudential_exceptions));
          if (b.application_ratio) paras.push(ensureLabel('POLICY & APPLICATION RATIO', b.application_ratio));
        }
      } else if (c.benchmark_alac) {
        const a = c.benchmark_alac;
        if (a.p1_direct_answer) paras.push(stripBolds(a.p1_direct_answer));
        if (a.p2_legal_basis) paras.push(stripBolds(a.p2_legal_basis));
        if (a.p3_analysis) paras.push(stripBolds(a.p3_analysis));
        if (a.p4_conclusion) paras.push(stripBolds(a.p4_conclusion));
      }
      return paras.filter(Boolean);
    }

    async function exportDeckAsMarkdownStudySheet(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || deck.cards.length === 0) return;

      const stripBolds = (str) => (str || '').replace(/\*\*/g, '').trim();
      let md = '';

      deck.cards.forEach((c, idx) => {
        const qNum = idx + 1;
        const headerLine = formatExportQuestionHeader(c, qNum);
        const rawQuestion = c.question_text || c.question || '';
        const question = sanitizeQuestionPrompt(stripBolds(rawQuestion));

        md += `**${headerLine}**\n\n`;
        md += `**${question}**\n\n`;

        const cleanParas = extractCardParagraphsForExport(c).map(p => sanitizeQuestionPrompt(p));
        md += cleanParas.join('\n\n');
        md += `\n\n---\n\n`;
      });

      const fileName = `${deck.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_WordReady.md`;
      await exportWithSaveDialog(
        '\uFEFF' + md,
        fileName,
        'text/markdown;charset=utf-8',
        'Markdown Study Sheet (.md)',
        '.md'
      );
    }

    async function exportDeckAsWordDoc(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || deck.cards.length === 0) return;

      const stripBolds = (str) => (str || '').replace(/\*\*/g, '').trim();
      let docHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset='utf-8'>
        <title>${escapeHtml(deck.title)}</title>
        <style>
          body { font-family: 'Georgia', 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #000; margin: 1in; }
          .doc-header { font-weight: bold; font-size: 13pt; margin-bottom: 14pt; border-bottom: 1.5px solid #000; padding-bottom: 6pt; }
          .q-title { font-weight: bold; font-size: 11.5pt; margin-top: 18pt; margin-bottom: 6pt; }
          .q-prompt { font-weight: bold; font-size: 11pt; margin-bottom: 12pt; }
          .ans-para { text-indent: 0.5in; margin-top: 0; margin-bottom: 12pt; text-align: justify; }
          hr { border: none; border-top: 1px solid #ccc; margin: 20pt 0; }
        </style>
      </head>
      <body>
        <div class="doc-header">${escapeHtml(deck.subject || currentSubjectName)} — ${escapeHtml(deck.title)} [${escapeHtml(state.operatingPipeline)}]</div>`;

      deck.cards.forEach((c, idx) => {
        const qNum = idx + 1;
        const headerLine = formatExportQuestionHeader(c, qNum);
        const rawQuestion = c.question_text || c.question || '';
        const question = sanitizeQuestionPrompt(stripBolds(rawQuestion));

        docHtml += `<div class="q-title">${escapeHtml(headerLine)}</div>`;
        docHtml += `<div class="q-prompt">${escapeHtml(question)}</div>`;

        const cleanParas = extractCardParagraphsForExport(c).map(p => sanitizeQuestionPrompt(p));
        cleanParas.forEach(p => {
          docHtml += `<p class="ans-para">${escapeHtml(p)}</p>`;
        });

        docHtml += `<hr/>`;
      });

      docHtml += `</body></html>`;

      const fileName = `${deck.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_Word.doc`;
      await exportWithSaveDialog(
        '\uFEFF' + docHtml,
        fileName,
        'application/msword;charset=utf-8',
        'Microsoft Word Document (.doc)',
        '.doc'
      );
    }

    async function renderDeckListUI() {
      const decks = await dbGetAll('decks');
      const searchQuery = document.getElementById('deckLibrarySearchInput')?.value.toLowerCase() || '';
      const container = document.getElementById('deckListContainer');
      const countBadge = document.getElementById('deckCountBadge');
      const headerBadge = document.getElementById('deckCountHeaderBadge');

      if (countBadge) countBadge.innerText = decks.length;
      if (headerBadge) headerBadge.innerText = decks.length;
      if (!container) return;
      container.innerHTML = '';

      const filteredDecks = decks.filter(d => d.title.toLowerCase().includes(searchQuery));

      if (filteredDecks.length === 0) {
        container.innerHTML = `<div id="emptyDecksNotice" class="text-xs text-slate-400 italic text-center py-3">${searchQuery ? 'No decks match your search.' : 'No saved decks for this subject yet. Compile a new deck below or import one.'}</div>`;
        return;
      }

      filteredDecks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      filteredDecks.forEach(deck => {
        const totalCards = deck.cards ? deck.cards.length : 0;
        const activeCards = (deck.cards || []).filter(c => !c.isSuspended && !isCardBuriedToday(c)).length;
        const suspendedCards = (deck.cards || []).filter(c => c.isSuspended).length;
        const buriedCards = (deck.cards || []).filter(c => isCardBuriedToday(c)).length;

        const div = document.createElement('div');
        div.className = "flex flex-col bg-slate-950 border border-slate-800 p-3 rounded-xl hover:border-slate-700 transition gap-2 shadow-sm";
        div.innerHTML = `
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <span class="font-bold text-slate-100 text-sm block truncate cursor-pointer hover:text-amber-300" onclick="renameDeckPrompt('${deck.id}')" title="Click to rename this deck">
                ${escapeHtml(deck.title)}
              </span>
              <span class="text-[10px] text-slate-500 font-mono block mt-0.5">
                Created: ${new Date(deck.createdAt).toLocaleDateString()} · Active: <b class="text-emerald-400">${activeCards}</b> / ${totalCards} cards
                ${suspendedCards > 0 ? `· <span class="text-red-400 font-bold" title="Temporarily removed from recitation queues without deleting">${suspendedCards} Suspended</span>` : ''}
                ${buriedCards > 0 ? `· <span class="text-amber-400 font-bold" title="Hidden from today's drills; automatically returns tomorrow">${buriedCards} Buried</span>` : ''}
              </span>
            </div>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-950 text-amber-300 border border-amber-800/70 font-bold shrink-0 whitespace-nowrap">
              ${totalCards} Cards
            </span>
          </div>

          <div class="flex items-center flex-wrap gap-1.5 pt-1.5 border-t border-slate-900">
            <!-- LAUNCH -->
            <button onclick="launchSavedDeck('${deck.id}')" class="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold rounded font-mono text-[11px] transition shadow" title="Launch an oral recitation drill with this deck">
              Launch (${activeCards})
            </button>
            <!-- REGENERATE & POLISH -->
            <button type="button" onclick="event.stopPropagation(); window.openDeckRegenerateModal('${deck.id}')" ontouchend="event.stopPropagation(); window.openDeckRegenerateModal('${deck.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 active:bg-purple-900 text-purple-300 border border-purple-800/60 rounded font-mono text-[11px] transition font-semibold cursor-pointer select-none" title="Polish, unbundle paragraphs, or upgrade cards with Cloze deletions using AI">
              ✨ Polish
            </button>
            
            <!-- VIEW CARDS -->
            <button onclick="openDeckBrowserModal('${deck.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/60 rounded font-mono text-[11px] transition font-bold" title="Inspect, search, view benchmarks, duplicate, suspend, or delete individual cards in this deck">
              🗂 View Cards (${totalCards})
            </button>

            <!-- ADD CARD DIRECTLY TO THIS DECK -->
            <button onclick="openStudioForSpecificDeck('${deck.id}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-800/60 rounded font-mono text-[11px] transition font-semibold" title="Add a custom card directly into this deck">
              + Add Card
            </button>
            
            <!-- DUPLICATE DECK -->
            <button onclick="duplicateSavedDeck('${deck.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded font-mono text-[11px] transition font-semibold" title="Creates an independent working copy of this deck so you can customize cards without altering the original">
              ⎘ Duplicate
            </button>

            <!-- MERGE DECKS -->
            <button onclick="promptMergeDecks('${deck.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-800/60 rounded font-mono text-[11px] transition font-semibold" title="Combines cards from another deck into this deck while keeping the source deck intact">
              ⚗ Merge
            </button>
            ${(deck.isMerged || (deck.cards && deck.cards.some(c => c.originDeckId))) ? `
            <!-- UNMERGE / SPLIT DECK -->
            <button onclick="unmergeDeck('${deck.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-rose-300 border border-rose-800/60 rounded font-mono text-[11px] transition font-semibold" title="Split this merged deck back into separate individual decks">
              ⚚ Unmerge
            </button>` : ''}

            <!-- EXPORT WORD / MD / JSON -->
            <button onclick="exportDeckAsMarkdownStudySheet('${deck.id}')" class="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded font-mono text-[10px] transition" title="Export this deck as an Obsidian/Markdown study sheet">
              .md
            </button>
            <button onclick="exportDeckAsWordDoc('${deck.id}')" class="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded font-mono text-[10px] transition" title="Export this deck as a formatted Microsoft Word study sheet">
              .doc
            </button>
            <button onclick="exportSingleDeckJSON('${deck.id}')" class="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-emerald-400 border border-slate-800 rounded font-mono text-[10px] transition" title="Export this deck as a shareable JSON file">
              JSON
            </button>

            <!-- RENAME -->
            <button onclick="renameDeckPrompt('${deck.id}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono text-[11px] transition" title="Rename this deck">
              Rename
            </button>

            <!-- DELETE DECK -->
            <button onclick="deleteSavedDeck('${deck.id}')" class="px-2 py-1 bg-slate-800 hover:bg-red-950 text-red-400 rounded font-mono text-[11px] ml-auto transition" title="Permanently delete this entire deck">
              ✕
            </button>
          </div>
        `;
        container.appendChild(div);
      });
    }


    // Field Expansion Logic
    let activeExpandFieldId = null;

    function openFieldExpand(fieldId, label) {
      const field = document.getElementById(fieldId);
      if (!field) return;
      activeExpandFieldId = fieldId;
      document.getElementById('expandFieldLabel').innerText = label;
      const textarea = document.getElementById('expandFieldTextarea');
      textarea.value = field.value;
      updateExpandCounts();
      document.getElementById('fieldExpandOverlay').classList.remove('hidden');
      textarea.focus();
    }

    function closeFieldExpand() {
      document.getElementById('fieldExpandOverlay').classList.add('hidden');
      activeExpandFieldId = null;
    }

    function updateExpandCounts() {
      const text = document.getElementById('expandFieldTextarea').value;
      document.getElementById('expandWordCount').innerText = text.trim() ? text.trim().split(/\s+/).length : 0;
      document.getElementById('expandCharCount').innerText = text.length;
    }

    function applyFieldExpand() {
      const field = document.getElementById(activeExpandFieldId);
      const text = document.getElementById('expandFieldTextarea').value;
      if (field) {
        field.value = text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closeFieldExpand();
    }

    document.getElementById('expandFieldTextarea')?.addEventListener('input', updateExpandCounts);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('fieldExpandOverlay').classList.contains('hidden')) {
        closeFieldExpand();
      }
    });

    async function launchSavedDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || deck.cards.length === 0) return;

      // Filter out cards that are permanently suspended or temporarily buried for today
      const playableCards = deck.cards.filter(c => !c.isSuspended && !isCardBuriedToday(c));
      if (playableCards.length === 0) {
        alert(`Cannot launch "${deck.title}": All ${deck.cards.length} cards are currently suspended or buried. Unsuspend or unbury cards to practice.`);
        return;
      }

      await requestScreenWakeLock();
      state.isSessionActive = true;
      const shouldShuffle = document.getElementById('shuffleDeckCheckbox')?.checked;
      state.activeAgenda = shouldShuffle ? shuffleArray(playableCards) : [...playableCards];
      state.activeDeckCardsPool = [...deck.cards];
      state.totalQuestions = state.activeAgenda.length;
      state.currentQuestionIndex = 1;
      state.sessionTranscript = [];
      state.activeDeckTitle = deck.title;

      document.getElementById('batchIndicatorBadge').innerText = shouldShuffle ? "(Saved Deck · Shuffled)" : "(Saved Deck)";
      document.getElementById('saveDeckHeaderBtn').classList.remove('hidden');
      toggleModal('setupModal');

      document.getElementById('progressDisplay').classList.remove('hidden');
      document.getElementById('currentQNum').innerText = '1';
      document.getElementById('totalQNum').innerText = state.totalQuestions;

      await launchActiveCard(1);
    }

    async function renameDeckPrompt(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck) return;
      const newTitle = prompt("Enter new title for this deck:", deck.title);
      if (newTitle && newTitle.trim()) {
        deck.title = newTitle.trim();
        await dbSave('decks', deck);
        await renderDeckListUI();
      }
    }

    async function deleteSavedDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck) return;
      if (confirm(`Delete deck "${deck.title}"?`)) {
        await dbDelete('decks', deckId);
        await renderDeckListUI();
      }
    }

    async function purgeAllSavedDecks() {
      if (confirm(`Permanently delete all saved decks for ${currentSubjectName}?`)) {
        await dbClearSubjectStore('decks');
        await renderDeckListUI();
      }
    }
    // =========================================================================
    // DECK MERGE & DUPLICATION ENGINE (NON-DESTRUCTIVE)
    // =========================================================================
    function isCardBuriedToday(card) {
      if (!card || !card.buriedUntil) return false;
      return new Date(card.buriedUntil).getTime() > Date.now();
    }

    async function duplicateSavedDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck) return;
      const copyTitle = prompt("Enter title for the duplicate deck:", `${deck.title} (Copy)`);
      if (!copyTitle || !copyTitle.trim()) return;

      const dupObj = {
        id: 'deck_copy_' + Date.now(),
        subject: currentSubjectName,
        title: copyTitle.trim(),
        createdAt: new Date().toISOString(),
        cards: Array.isArray(deck.cards) ? JSON.parse(JSON.stringify(deck.cards)) : []
      };

      await dbSave('decks', dupObj);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      alert(`✅ Duplicated deck: "${dupObj.title}" (${dupObj.cards.length} cards).`);
    }

// =========================================================================
    // VISUAL DECK MERGE & ACTIVE UNMERGE CONTROLLER
    // =========================================================================
    let activeMergeSourceDecks = [];

    async function promptMergeDecks(preSelectedDeckId) {
      activeMergeSourceDecks = await dbGetAll('decks');      if (activeMergeSourceDecks.length < 2) {
        alert("You need at least two saved decks in this subject workspace to perform a merge.");
        return;
      }

      const selA = document.getElementById('mergeDeckASelect');
      const selB = document.getElementById('mergeDeckBSelect');
      if (!selA || !selB) return;

      selA.innerHTML = '';
      selB.innerHTML = '';

      activeMergeSourceDecks.forEach((d, idx) => {
        const count = d.cards ? d.cards.length : 0;
        const optA = document.createElement('option');
        optA.value = d.id;
        optA.innerText = `${d.title} (${count} cards)`;
        selA.appendChild(optA);

        const optB = document.createElement('option');
        optB.value = d.id;
        optB.innerText = `${d.title} (${count} cards)`;
        selB.appendChild(optB);
      });

      if (preSelectedDeckId) {
        selA.value = preSelectedDeckId;
        const other = activeMergeSourceDecks.find(d => d.id !== preSelectedDeckId);
        if (other) selB.value = other.id;
      } else {
        selA.selectedIndex = 0;
        selB.selectedIndex = 1;
      }

      document.getElementById('deckMergeModal').classList.remove('hidden');
      onMergeDeckSelectionChanged();
    }

    let activeEditingCardIndex = null;
    let activeEditingDeckId = null;

    function closeMergeModal() {
      document.getElementById('deckMergeModal').classList.add('hidden');
      editingMergeCardContext = null;
    }

    let activePolishDeckId = null;
    let flaggedDuplicates = [];

    window.openDeckRegenerateModal = function(deckId) {
      openDeckPolishModal(deckId);
    };

    async function openDeckPolishModal(deckId) {
      activePolishDeckId = deckId;
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || deck.cards.length === 0) {
        alert("This deck has no cards to polish or deduplicate.");
        return;
      }

      const modal = document.getElementById('deckPolishModal');
      const subtitle = document.getElementById('polishModalDeckSubtitle');
      const totalText = document.getElementById('polishDeckTotalCardsText');
      const dupBadge = document.getElementById('polishDuplicateBadge');
      const dupList = document.getElementById('polishDuplicatesList');
      const purgeBtn = document.getElementById('executePolishPurgeBtn');

      if (subtitle) subtitle.innerText = `Deck: "${deck.title}" (${deck.cards.length} Total Cards)`;
      if (totalText) totalText.innerText = `${deck.cards.length} Cards in Deck`;

      // Scan and find duplicate cards
      flaggedDuplicates = [];
      const seenSignatures = new Map();
      const duplicateIndices = new Set();

      deck.cards.forEach((card, idx) => {
        const rawTopic = (card.baseTopic || card.topic || card.case_title || '').trim().toLowerCase();
        const dimId = card.dimensionId || card.forcedDimensionId || 'general';
        const cleanPrompt = sanitizeQuestionPrompt(card.question_text || card.question || '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');

        // Form signature based on topic + dimension or prompt text
        const topicDimSig = `${rawTopic}::dim_${dimId}`;
        const promptSig = cleanPrompt.length > 25 ? cleanPrompt.substring(0, 90) : topicDimSig;

        if (seenSignatures.has(topicDimSig) || (cleanPrompt.length > 25 && seenSignatures.has(promptSig))) {
          duplicateIndices.add(idx);
          flaggedDuplicates.push({
            index: idx,
            card: card,
            reason: seenSignatures.has(topicDimSig) ? `Duplicate dimension (${dimId}) for topic` : 'Identical question prompt'
          });
        } else {
          seenSignatures.set(topicDimSig, idx);
          if (cleanPrompt.length > 25) seenSignatures.set(promptSig, idx);
        }
      });

      if (dupBadge) {
        dupBadge.innerText = `${flaggedDuplicates.length} Redundant Cards Detected`;
        dupBadge.className = flaggedDuplicates.length > 0
          ? "px-3 py-1 rounded text-xs font-mono font-bold bg-amber-950 text-amber-300 border border-amber-800"
          : "px-3 py-1 rounded text-xs font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800";
      }

      if (dupList) {
        if (flaggedDuplicates.length === 0) {
          dupList.innerHTML = `<span class="text-emerald-400 italic">No duplicate or redundant cards detected. The deck is fully unique!</span>`;
        } else {
          dupList.innerHTML = flaggedDuplicates.map(dup => {
            const title = dup.card.topic || dup.card.case_title || `Card ${dup.index + 1}`;
            return `
              <div class="flex items-center justify-between py-1 border-b border-slate-900 gap-2">
                <span class="truncate text-slate-300">#${dup.index + 1}. ${escapeHtml(title)}</span>
                <span class="text-amber-400 text-[10px] shrink-0 font-bold">[${escapeHtml(dup.reason)}]</span>
              </div>
            `;
          }).join('');
        }
      }

      if (purgeBtn) {
        purgeBtn.disabled = false;
        purgeBtn.innerText = flaggedDuplicates.length > 0 
          ? `⚡ Purge ${flaggedDuplicates.length} Redundancies & Clean Deck`
          : `✨ Sanitize & Clean Formatting (0 Duplicates)`;
      }

      if (modal) modal.classList.remove('hidden');
    }

    function closeDeckPolishModal() {
      document.getElementById('deckPolishModal')?.classList.add('hidden');
      activePolishDeckId = null;
      flaggedDuplicates = [];
    }

    // ---------------------------------------------------------------------------
    // CARD SIMILARITY & MASHING HELPERS
    // ---------------------------------------------------------------------------
    const SIMILARITY_THRESHOLD = 0.85;
    const MASH_FIELDS = [
        'benchmark_codal_breakdown', 'benchmark_fir', 'benchmark_alac', 'benchmark_comparative',
        'governing_rule', 'distractor_rationale', 'solution_breakdown', 'formula_breakdown',
        'choice_a', 'choice_b', 'choice_c', 'choice_d'
    ];

    // Extract section/article number from text
    function extractSectionNumber(text) {
      if (!text) return null;
      const match = text.match(/(?:Section|Sec\.|Article|Art\.|PFRS|PAS)\s*(\d+)/i);
      return match ? match[1] : null;
    }

    // Extract rule reference from text
    function extractRuleReference(text) {
      if (!text) return null;
      const match = text.match(/(Rule\s+\d+|R\.A\.\s*\d+)/i);
      return match ? match[0] : null;
    }

    // Card signature includes section/article to prevent cross-section collisions
    function cardSignature(card) {
      const rawTopic = (card.baseTopic || card.topic || card.case_title || '').trim();
      const rawPrompt = card.question_text || card.question || '';
      const dimId = card.dimensionId || card.forcedDimensionId || 'general';

      // Extract section/article from topic and prompt
      const sectionFromTopic = extractSectionNumber(rawTopic);
      const sectionFromPrompt = extractSectionNumber(rawPrompt);
      const section = sectionFromTopic || sectionFromPrompt;

      // Build signature with section if present
      const topicPart = rawTopic.trim().toLowerCase();
      const sigBase = section ? `${topicPart}::section_${section}` : topicPart;

      // For dimension 9 (hypotheticals) or ALAC, include prompt similarity requirement
      const schemaType = card.schemaType;
      if (dimId === 9 || schemaType === 'ALAC' ||
          (rawPrompt && (rawPrompt.startsWith('During the trial') ||
                         rawPrompt.startsWith('A filed') ||
                         rawPrompt.startsWith('Suppose') ||
                         rawPrompt.match(/^[A-Z] and [A-Z]/) ||
                         rawPrompt.match(/Dim 9/i)))) {
        return `${sigBase}::hypothetical_dim_${dimId}`;
      }

      return `${sigBase}::dim_${dimId}`;
    }

    // Token-based similarity calculation
    function cardTokenSimilarity(a, b) {
      const ta = (a || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
      const tb = (b || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
      if (ta.length === 0 || tb.length === 0) return 0;
      const setB = new Set(tb);
      let intersect = 0;
      ta.forEach(t => { if (setB.has(t)) intersect++; });
      return intersect / Math.max(ta.length, tb.length);
    }

    // Merge two cards' content, avoiding MASHED ADDITION markers
    function mergeField(a, b) {
      if (!a) return b;
      if (!b) return a;
      if (typeof a === 'string' && typeof b === 'string') {
        // Strip existing MASHED ADDITION markers
        const cleanA = a.replace(/---\s*MASHED ADDITION\s*---/gi, '').replace(/\n\s*\n/g, '\n').trim();
        const cleanB = b.replace(/---\s*MASHED ADDITION\s*---/gi, '').replace(/\n\s*\n/g, '\n').trim();

        if (cleanA === cleanB) return cleanA;
        if (cleanA.includes(cleanB) && cleanB.length > 0) return cleanA;
        if (cleanB.includes(cleanA) && cleanA.length > 0) return cleanB;

        // Use longer text, join with double newline
        return cleanA.length >= cleanB.length ? cleanA + '\n\n' + cleanB : cleanB + '\n\n' + cleanA;
      }
      if (typeof a === 'object' && typeof b === 'object' && a && b) {
        const merged = JSON.parse(JSON.stringify(a));
        Object.keys(b).forEach(k => {
          if (b[k] == null) return;
          if (MASH_FIELDS.includes(k) || k === 'codal_provision_text') {
            merged[k] = mergeField(merged[k], b[k]);
          } else if (!(k in merged)) {
            merged[k] = b[k];
          }
        });
        return merged;
      }
      return a;
    }

    // Main card merge function
    function mergeCards(survivor, donor) {
      const merged = JSON.parse(JSON.stringify(survivor));
      const qText = mergeField(survivor.question_text || survivor.question || '', donor.question_text || donor.question || '');
      merged.question_text = qText;
      if (!merged.question) merged.question = qText;

      MASH_FIELDS.forEach(f => {
        if (donor[f] != null) {
          merged[f] = mergeField(merged[f], donor[f]);
        }
      });
      if (donor.codal_provision_text) {
        merged.codal_provision_text = mergeField(merged.codal_provision_text, donor.codal_provision_text);
      }

      // Metadata & flags
      if (donor.topic && (!merged.topic || donor.topic.length > merged.topic.length)) merged.topic = donor.topic;
      if (donor.case_title && (!merged.case_title || donor.case_title.length > merged.case_title.length)) merged.case_title = donor.case_title;
      if (donor.citation && (!merged.citation || donor.citation.length > merged.citation.length)) merged.citation = donor.citation;
      if (donor.isSuspended) merged.isSuspended = true;
      if (donor.buriedUntil && (!merged.buriedUntil || donor.buriedUntil > merged.buriedUntil)) merged.buriedUntil = donor.buriedUntil;
      if (donor.isGrounded) merged.isGrounded = true;

      if (Array.isArray(donor.tags) && donor.tags.length) {
        merged.tags = Array.from(new Set([...(merged.tags || []), ...donor.tags]));
      }

      if (!merged.mashedFrom) merged.mashedFrom = [];
      if (survivor.mashedFrom) merged.mashedFrom.push(...survivor.mashedFrom);
      if (donor.mashedFrom) merged.mashedFrom.push(...donor.mashedFrom);
      else merged.mashedFrom.push({ index: donor._origIndex, reason: donor._mashReason || 'similar' });

      merged._mashCount = (merged._mashCount || 1) + 1;
      return merged;
    }

    // Main mashing pass - handles cross-section, cross-hypothetical collisions
    function cardMashPass(cards, threshold = SIMILARITY_THRESHOLD) {
      const survivors = [];
      const mashed = [];
      const seenSigs = new Map();
      const cardSections = new Map(); // Track section per card for cross-section detection

      const refreshSigPointers = (merged) => {
        for (const [k, v] of seenSigs) {
          if (v === merged._preMergeRef) seenSigs.set(k, merged);
        }
      };

      cards.forEach((card, idx) => {
        card._origIndex = idx;
        const sig = cardSignature(card);
        const promptText = card.question_text || card.question || '';
        const cardSection = extractSectionNumber(promptText) || extractSectionNumber(card.topic || card.case_title || '');
        const cardDimensionId = card.dimensionId || card.forcedDimensionId || 1;
        const schemaType = card.schemaType;

        // Detect if this is a hypothetical/problem card
        const isHypothetical = cardDimensionId === 9 || schemaType === 'ALAC' ||
          (promptText && (promptText.startsWith('During the trial') ||
                         promptText.startsWith('A filed') ||
                         promptText.startsWith('Suppose') ||
                         promptText.match(/^[A-Z] and [A-Z]/) ||
                         promptText.match(/Dim 9/i)));

        let matched = null;
        let matchReason = '';

        if (seenSigs.has(sig)) {
          matched = seenSigs.get(sig);

          // Check for cross-section collision
          const matchedSection = cardSections.get(matched._origIndex) || extractSectionNumber(matched.question_text || matched.question || '');
          if (cardSection && matchedSection && cardSection !== matchedSection) {
            matchReason = 'cross_section_collision';
            matched = null;
          }
        }

        // If no match by signature, check similarity
        if (!matched) {
          for (const [otherSig, cand] of seenSigs) {
            const candSection = cardSections.get(cand._origIndex) || extractSectionNumber(cand.question_text || cand.question || '');

            // Skip if sections differ
            if (cardSection && candSection && cardSection !== candSection) {
              continue;
            }

            // For hypotheticals, require higher similarity (0.88)
            const isCandHypothetical = (cand.dimensionId || cand.forcedDimensionId || 1) === 9 ||
              (cand.schemaType === 'ALAC' ||
               (cand.question_text || cand.question || '').startsWith('During the trial') ||
               (cand.question_text || cand.question || '').startsWith('A filed') ||
               (cand.question_text || cand.question || '').match(/^[A-Z] and [A-Z]/));

            const similarityThreshold = (isHypothetical || isCandHypothetical) ? 0.88 : threshold;

            if (cardTokenSimilarity(promptText, cand.question_text || cand.question || '') >= similarityThreshold) {
              matched = cand;
              matchReason = 'similar';
              break;
            }
          }
        }

        if (matched) {
          const reason = matched._origIndex === idx ? 'duplicate' : matchReason;
          card._mashReason = reason;
          const merged = mergeCards(matched, card);
          merged._mashReason = reason;
          merged._preMergeRef = matched;

          const pos = survivors.indexOf(matched);
          if (pos >= 0) survivors[pos] = merged;
          else survivors.push(merged);

          seenSigs.set(sig, merged);
          cardSections.set(merged._origIndex, cardSection);
          refreshSigPointers(merged);
          mashed.push({ index: idx, survivorIndex: pos >= 0 ? pos : survivors.length - 1, reason });
        } else {
          seenSigs.set(sig, card);
          cardSections.set(idx, cardSection);
          survivors.push(card);
        }
      });
      return { survivors, mashed };
    }

    function sanitizeCardText(card) {
      if (card.question_text) {
        card.question_text = card.question_text.replace(/---\s*MASHED ADDITION\s*---/gi, '').replace(/\n\s*\n/g, '\n').trim();
      }
      if (card.question) {
        card.question = card.question.replace(/---\s*MASHED ADDITION\s*---/gi, '').replace(/\n\s*\n/g, '\n').trim();
      }
      return card;
    }

    async function executeDeckDeduplication() {
      if (!activePolishDeckId) return;
      const deck = await dbGet('decks', activePolishDeckId);
      if (!deck || !deck.cards) return;

      const initialCount = deck.cards.length;
      const seenSignatures = new Set();
      const uniqueCleanedCards = [];

      deck.cards.forEach((card) => {
        // Sanitize card text and prompts during the polish pass
        if (card.question_text) {
          card.question_text = sanitizeQuestionPrompt(card.question_text);
        }
        if (card.question) {
          card.question = sanitizeQuestionPrompt(card.question);
        }

        const rawTopic = (card.baseTopic || card.topic || card.case_title || '').trim().toLowerCase();
        const dimId = card.dimensionId || card.forcedDimensionId || 'general';
        const cleanPrompt = (card.question_text || card.question || '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');

        const topicDimSig = `${rawTopic}::dim_${dimId}`;
        const promptSig = cleanPrompt.length > 25 ? cleanPrompt.substring(0, 90) : topicDimSig;

        if (!seenSignatures.has(topicDimSig) && (!cleanPrompt.length || !seenSignatures.has(promptSig))) {
          seenSignatures.add(topicDimSig);
          if (cleanPrompt.length > 25) seenSignatures.add(promptSig);
          uniqueCleanedCards.push(card);
        }
      });

      const removedCount = initialCount - uniqueCleanedCards.length;
      deck.cards = uniqueCleanedCards;

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();

      // If this polished deck is currently active in the recitation session, sync the changes live
      if (state.activeDeckTitle === deck.title && state.isSessionActive) {
        state.activeAgenda = [...uniqueCleanedCards];
        state.activeDeckCardsPool = [...uniqueCleanedCards];
        state.totalQuestions = uniqueCleanedCards.length;
        document.getElementById('totalQNum').innerText = state.totalQuestions;
        if (state.currentQuestionIndex > state.totalQuestions) {
          state.currentQuestionIndex = state.totalQuestions;
        }
        await launchActiveCard(state.currentQuestionIndex);
      }

      closeDeckPolishModal();
      alert(`✅ Deck Polish Complete!\n\nRemoved ${removedCount} redundant card(s).\nDeck now contains ${uniqueCleanedCards.length} high-yield unique cards.`);
    }
    function closeCardCreatorModal() {
      document.getElementById('cardCreatorModal')?.classList.add('hidden');
      document.getElementById('deleteCardFromStudioBtn')?.classList.add('hidden');
      editingMergeCardContext = null;
      activeEditingCardIndex = null;
      activeEditingDeckId = null;
    }

    async function editActiveCardInPlace(fromEvalModal = false) {
      if (!state.activeAgenda || state.activeAgenda.length === 0) {
        alert("No active card currently selected to edit.");
        return;
      }

      if (fromEvalModal) {
        closeEvaluation();
      }

      const cardIdx = state.currentQuestionIndex - 1;
      const card = state.activeAgenda[cardIdx];
      if (!card) return;

      activeEditingCardIndex = cardIdx;

      // Show the Delete Card button in the editor footer
      const deleteBtn = document.getElementById('deleteCardFromStudioBtn');
      if (deleteBtn) deleteBtn.classList.remove('hidden');

      const studioModal = document.getElementById('cardCreatorModal');
      if (studioModal) studioModal.classList.remove('hidden');

      const titleEl = document.getElementById('cardCreatorModalTitle');
      if (titleEl) titleEl.innerText = `Edit Card (${state.currentQuestionIndex} of ${state.totalQuestions})`;

      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = sanitizeQuestionPrompt(card.question_text || card.question || state.currentQuestionText || '');

      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      if (card.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = card.benchmark_fir || {};
        if (document.getElementById('caseFactsInput')) document.getElementById('caseFactsInput').value = fir.facts || '';
        if (document.getElementById('caseIssueInput')) document.getElementById('caseIssueInput').value = fir.issue || '';
        if (document.getElementById('caseRulingInput')) document.getElementById('caseRulingInput').value = fir.ruling || '';
        if (document.getElementById('caseRatioInput')) document.getElementById('caseRatioInput').value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (card.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = card.benchmark_codal_breakdown || {};
        if (document.getElementById('codalRuleInput')) document.getElementById('codalRuleInput').value = card.codal_provision_text || b.operative_rule_summary || '';
        if (document.getElementById('codalRequisitesInput')) document.getElementById('codalRequisitesInput').value = b.elements_requisites || '';
        if (document.getElementById('codalStatExceptionsInput')) document.getElementById('codalStatExceptionsInput').value = b.statutory_exceptions || '';
        if (document.getElementById('codalJurisExceptionsInput')) document.getElementById('codalJurisExceptionsInput').value = b.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = card.benchmark_alac || {};
        if (document.getElementById('alacAInput')) document.getElementById('alacAInput').value = alac.p1_direct_answer || '';
        if (document.getElementById('alacLInput')) document.getElementById('alacLInput').value = alac.p2_legal_basis || '';
        if (document.getElementById('alacAppInput')) document.getElementById('alacAppInput').value = alac.p3_analysis || '';
        if (document.getElementById('alacCInput')) document.getElementById('alacCInput').value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        if (document.getElementById('simpleAnswerInput')) document.getElementById('simpleAnswerInput').value = card.answer || card.model_answer || '';
      }

      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Card";
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    async function deleteActiveEditingCard() {
      // 1. If deleting from the Merge Workspace
      if (editingMergeCardContext) {
        if (!confirm("Are you sure you want to remove this card from the source deck?")) return;
        const { originDeckId, cardIdxInOrigin } = editingMergeCardContext;
        const deck = await dbGet('decks', originDeckId);
        if (deck && deck.cards) {
          deck.cards.splice(cardIdxInOrigin, 1);
          await dbSave('decks', deck);
          await stampSubjectModifiedTimestamp();
          activeMergeSourceDecks = await dbGetAll('decks');
        }
        closeCardCreatorModal();
        const mergeModal = document.getElementById('deckMergeModal');
        if (mergeModal) {
          mergeModal.classList.remove('hidden');
          if (typeof onMergeDeckSelectionChanged === 'function') onMergeDeckSelectionChanged();
        }
        return;
      }

      // 2. If deleting during an active recitation session
      if (activeEditingCardIndex !== null && state.activeAgenda && state.activeAgenda[activeEditingCardIndex]) {
        const cardToDelete = state.activeAgenda[activeEditingCardIndex];
        const cardTitle = cardToDelete.topic || cardToDelete.case_title || `Card ${activeEditingCardIndex + 1}`;

        if (!confirm(`Permanently delete "${cardTitle}" from the active deck/session?`)) {
          return;
        }

        // Remove from active agenda and pools
        state.activeAgenda.splice(activeEditingCardIndex, 1);
        if (state.activeDeckCardsPool && state.activeDeckCardsPool.length > activeEditingCardIndex) {
          state.activeDeckCardsPool.splice(activeEditingCardIndex, 1);
        }

        // If practicing from a saved deck, sync deletion to IndexedDB
        if (state.activeDeckTitle) {
          const decks = await dbGetAll('decks');
          const targetDeck = decks.find(d => d.title === state.activeDeckTitle);
          if (targetDeck && targetDeck.cards) {
            targetDeck.cards = targetDeck.cards.filter(c => (c.topic || c.case_title) !== (cardToDelete.topic || cardToDelete.case_title));
            await dbSave('decks', targetDeck);
            await stampSubjectModifiedTimestamp();
            await renderDeckListUI();
          }
        }

        state.totalQuestions = state.activeAgenda.length;
        document.getElementById('totalQNum').innerText = state.totalQuestions;

        closeCardCreatorModal();

        if (state.activeAgenda.length === 0) {
          alert("All cards in this batch have been deleted.");
          window.location.reload();
          return;
        }

        // If the deleted card was the last card, adjust index
        if (state.currentQuestionIndex > state.totalQuestions) {
          state.currentQuestionIndex = state.totalQuestions;
        }

        await launchActiveCard(state.currentQuestionIndex);
      }
    }

    async function openStudioToEditMergeCard(originDeckId, cardIdxInOrigin) {
      const deck = await dbGet('decks', originDeckId);
      if (!deck || !deck.cards || !deck.cards[cardIdxInOrigin]) {
        alert("Card could not be loaded from source deck.");
        return;
      }

      const card = deck.cards[cardIdxInOrigin];
      editingMergeCardContext = { originDeckId, cardIdxInOrigin, cardRef: card };

      // Temporarily hide the Deck Merge modal while editing
      const mergeModal = document.getElementById('deckMergeModal');
      if (mergeModal) mergeModal.classList.add('hidden');

      // Open the Card Studio modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Pre-fill Title, Citation, and Prompt
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || card.question || '';

      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Populate Dynamic Sub-fields
      if (card.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = card.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (card.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = card.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = card.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Configure Modal Actions
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Merge Card";

      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    async function applyMergeCardUpdate() {
      if (!editingMergeCardContext) return;
      const { originDeckId, cardIdxInOrigin } = editingMergeCardContext;

      const deck = await dbGet('decks', originDeckId);
      if (!deck || !deck.cards || !deck.cards[cardIdxInOrigin]) return;

      const targetCard = deck.cards[cardIdxInOrigin];
      const topic = document.getElementById('customTopicInput')?.value.trim() || targetCard.topic || '';
      const citation = document.getElementById('customCitationInput')?.value.trim() || '';
      const question = document.getElementById('customQuestionPromptInput')?.value.trim() || '';

      targetCard.topic = topic;
      if (targetCard.case_title) targetCard.case_title = topic;
      targetCard.citation = citation;
      targetCard.rule_citation = citation;
      targetCard.question_text = question;

      const archetype = currentCardArchetype || 'CODAL';

      if (archetype === 'CASE') {
        targetCard.benchmark_fir = {
          facts: document.getElementById('caseFactsInput')?.value.trim() || '',
          issue: document.getElementById('caseIssueInput')?.value.trim() || '',
          ruling: document.getElementById('caseRulingInput')?.value.trim() || '',
          ratio_doctrine: document.getElementById('caseRatioInput')?.value.trim() || ''
        };
      } else if (archetype === 'CODAL') {
        targetCard.benchmark_codal_breakdown = {
          operative_rule_summary: document.getElementById('codalRuleInput')?.value.trim() || '',
          elements_requisites: document.getElementById('codalRequisitesInput')?.value.trim() || '',
          statutory_exceptions: document.getElementById('codalStatExceptionsInput')?.value.trim() || '',
          jurisprudential_exceptions: document.getElementById('codalJurisExceptionsInput')?.value.trim() || '',
          application_ratio: targetCard.benchmark_codal_breakdown?.application_ratio || ''
        };
        targetCard.codal_provision_text = targetCard.benchmark_codal_breakdown.operative_rule_summary;
      } else if (archetype === 'ALAC') {
        targetCard.benchmark_alac = {
          p1_direct_answer: document.getElementById('alacAInput')?.value.trim() || '',
          p2_legal_basis: document.getElementById('alacLInput')?.value.trim() || '',
          p3_analysis: document.getElementById('alacAppInput')?.value.trim() || '',
          p4_conclusion: document.getElementById('alacCInput')?.value.trim() || ''
        };
      } else {
        const simple = document.getElementById('simpleAnswerInput')?.value.trim() || '';
        targetCard.answer = simple;
        targetCard.model_answer = simple;
      }

      // Persist changes to source deck in IndexedDB
      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();

      // Refresh memory list of merge decks
      activeMergeSourceDecks = await dbGetAll('decks');

      // Close Card Studio
      document.getElementById('cardCreatorModal')?.classList.add('hidden');
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Save Card";
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.remove('hidden');

      // Re-open and refresh Merge Preview modal
      editingMergeCardContext = null;
      const mergeModal = document.getElementById('deckMergeModal');
      if (mergeModal) {
        mergeModal.classList.remove('hidden');
        if (typeof onMergeDeckSelectionChanged === 'function') onMergeDeckSelectionChanged();
      }
    }

    function onMergeDeckSelectionChanged() {
      const idA = document.getElementById('mergeDeckASelect').value;
      const idB = document.getElementById('mergeDeckBSelect').value;
      const container = document.getElementById('mergeCardsListContainer');
      const summaryBadge = document.getElementById('mergeSummaryBadge');
      const titleInput = document.getElementById('mergeNewDeckTitleInput');
      const isDedup = document.getElementById('mergeDedupToggle').checked;

      const deckA = activeMergeSourceDecks.find(d => d.id === idA);
      const deckB = activeMergeSourceDecks.find(d => d.id === idB);

      if (!deckA || !deckB) return;

      if (idA === idB) {
        container.innerHTML = `<div class="text-amber-400 italic text-center py-8">Please choose two different decks to merge.</div>`;
        summaryBadge.innerText = "Select two distinct decks";
        return;
      }

      titleInput.value = `${deckA.title} + ${deckB.title} (Merged)`;

      const cardsA = Array.isArray(deckA.cards) ? deckA.cards : [];
      const cardsB = Array.isArray(deckB.cards) ? deckB.cards : [];

      let mergedList = [];
      const seen = new Set();

      cardsA.forEach((c, idx) => {
        const sig = (c.question_text || c.topic || c.case_title || '').trim().toLowerCase();
        seen.add(sig);
        mergedList.push({ card: c, sourceLabel: deckA.title, sourceColor: 'text-amber-300 border-amber-800 bg-amber-950/40', originId: deckA.id, cardIdxInOrigin: idx });
      });

      cardsB.forEach((c, idx) => {
        const sig = (c.question_text || c.topic || c.case_title || '').trim().toLowerCase();
        if (isDedup && seen.has(sig)) return;
        seen.add(sig);
        mergedList.push({ card: c, sourceLabel: deckB.title, sourceColor: 'text-sky-300 border-sky-800 bg-sky-950/40', originId: deckB.id, cardIdxInOrigin: idx });
      });

      summaryBadge.innerText = `${mergedList.length} Cards Total (${cardsA.length} from Deck 1, ${cardsB.length} from Deck 2)`;

      container.innerHTML = mergedList.map((entry, idx) => {
        const c = entry.card;
        const topic = c.topic || c.case_title || 'Untitled Card';
        const prompt = c.question_text || c.question || 'No question prompt text available';
        const dimTag = c.exportTag || (c.dimensionId ? `Dim ${c.dimensionId}` : '');

        return `
          <div class="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-1 hover:border-slate-700 transition">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-slate-100 truncate">${idx + 1}. ${escapeHtml(topic)}</span>
              <div class="flex items-center space-x-2 shrink-0">
                ${dimTag ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">${escapeHtml(dimTag)}</span>` : ''}
                <span class="px-2 py-0.5 rounded text-[10px] font-mono border ${entry.sourceColor}">${escapeHtml(entry.sourceLabel)}</span>
                <button type="button" onclick="openStudioToEditMergeCard('${entry.originId}', ${entry.cardIdxInOrigin})" class="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/60 rounded text-[10px] font-mono transition font-semibold" title="Edit this card before merging">
                  ✏️ Edit
                </button>
              </div>
            </div>
            <p class="text-slate-400 text-[11px] line-clamp-2 leading-relaxed">${escapeHtml(prompt)}</p>
          </div>
        `;
      }).join('');
    }

    async function executeDeckMerge() {
      const idA = document.getElementById('mergeDeckASelect').value;
      const idB = document.getElementById('mergeDeckBSelect').value;
      const newTitle = document.getElementById('mergeNewDeckTitleInput').value.trim();
      const isDedup = document.getElementById('mergeDedupToggle').checked;

      if (idA === idB) {
        alert("Select two different decks to merge.");
        return;
      }
      if (!newTitle) {
        alert("Please enter a title for the new merged deck.");
        return;
      }

      const deckA = activeMergeSourceDecks.find(d => d.id === idA);
      const deckB = activeMergeSourceDecks.find(d => d.id === idB);
      if (!deckA || !deckB) return;

      const combined = [];
      const seen = new Set();

      const addCard = (card, originId, originTitle) => {
        const sig = (card.question_text || card.topic || card.case_title || '').trim().toLowerCase();
        if (isDedup && seen.has(sig)) return;
        seen.add(sig);

        combined.push({
          ...JSON.parse(JSON.stringify(card)),
          id: 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          originDeckId: originId,
          originDeckTitle: originTitle
        });
      };

      (deckA.cards || []).forEach(c => addCard(c, deckA.id, deckA.title));
      (deckB.cards || []).forEach(c => addCard(c, deckB.id, deckB.title));

      const mergedDeckObj = {
        id: 'deck_merged_' + Date.now(),
        subject: currentSubjectName,
        title: newTitle,
        createdAt: new Date().toISOString(),
        cards: combined,
        isMerged: true,
        originMetadata: {
          deckA: { id: deckA.id, title: deckA.title },
          deckB: { id: deckB.id, title: deckB.title }
        }
      };

      await dbSave('decks', mergedDeckObj);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      closeMergeModal();

      alert(`✅ Created merged deck: "${mergedDeckObj.title}" with ${mergedDeckObj.cards.length} cards.\nOriginal decks were preserved.`);
    }

    // ACTIVE UNMERGE / SPLIT DECK
    async function unmergeDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards) return;

      const cardsByOrigin = {};
      deck.cards.forEach(c => {
        const originId = c.originDeckId || 'original_remainder';
        const originTitle = c.originDeckTitle || 'Remainder Deck';
        if (!cardsByOrigin[originId]) {
          cardsByOrigin[originId] = { title: originTitle, cards: [] };
        }
        cardsByOrigin[originId].cards.push(c);
      });

      const originKeys = Object.keys(cardsByOrigin);
      if (originKeys.length < 2) {
        alert("This deck does not contain separate origin tags to automatically split.");
        return;
      }

      if (!confirm(`Split "${deck.title}" back into ${originKeys.length} separate decks?`)) return;

      for (const key of originKeys) {
        const group = cardsByOrigin[key];
        const splitDeck = {
          id: 'deck_split_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          subject: currentSubjectName,
          title: `${group.title} (Split from ${deck.title})`,
          createdAt: new Date().toISOString(),
          cards: group.cards
        };
        await dbSave('decks', splitDeck);
      }

      await renderDeckListUI();
      alert(`✅ Successfully split "${deck.title}" into ${originKeys.length} separate decks.`);
    }

// Automatically retrieves active cards from state pools or directly from IndexedDB
async function getActiveCards() {
      if (state.activeDeckCardsPool && state.activeDeckCardsPool.length > 0) {
        return state.activeDeckCardsPool;
      }
      if (state.activeAgenda && state.activeAgenda.length > 0) {
        return state.activeAgenda;
      }
      if (state.allUnbundledPool && state.allUnbundledPool.length > 0) {
        return state.allUnbundledPool;
      }

      // Direct IndexedDB query fallback
      try {
        const allDecks = await dbGetAll('decks');
        if (allDecks && allDecks.length > 0) {
          allDecks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          if (allDecks[0].cards && allDecks[0].cards.length > 0) {
            return allDecks[0].cards;
          }
        }
      } catch (err) {
        console.warn("Could not query decks from DB:", err);
      }

      const stored = localStorage.getItem('bar_recitation_cards') || localStorage.getItem('cards') || localStorage.getItem('deck');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch (_) {}
      }
      return [];
    }

    async function exportSingleDeckJSON(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || deck.cards.length === 0) {
        alert("This deck has no cards to export.");
        return;
      }

      const payload = {
        format: "ph_bar_recit_deck_v1",
        deckId: deck.id,
        title: deck.title,
        subject: deck.subject || currentSubjectName,
        createdAt: deck.createdAt,
        cardCount: deck.cards.length,
        cards: deck.cards
      };

      const fileName = `${deck.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_Deck.json`;
      const jsonContent = JSON.stringify(payload, null, 2);

      await exportWithSaveDialog(
        jsonContent,
        fileName,
        'application/json',
        'Bar Recitation Deck (.json)',
        '.json'
      );
    }

    async function handleDeckImport(event) {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data.cards || !Array.isArray(data.cards)) throw new Error("Invalid deck JSON.");
        const deckObj = {
          id: data.deckId || ('deck_' + Date.now()),
          title: data.title || file.name.replace(/\.[^/.]+$/, ""),
          subject: currentSubjectName,
          createdAt: data.createdAt || new Date().toISOString(),
          cards: data.cards
        };
        await dbSave('decks', deckObj);
        await renderDeckListUI();
        alert(`Imported deck "${deckObj.title}" (${deckObj.cards.length} cards) into ${currentSubjectName}.`);
      } catch (e) {
        alert("Import error: " + e.message);
      } finally {
        event.target.value = '';
      }
    }

    async function promptSaveCurrentRunAsDeck() {
      const cardsToSave = state.activeDeckCardsPool.length > 0 ? state.activeDeckCardsPool : state.activeAgenda;
      if (!cardsToSave || cardsToSave.length === 0) {
        alert("No active cards to save.");
        return;
      }
      const defaultTitle = state.activeDeckTitle || `${currentSubjectName} - Universal Deck (${cardsToSave.length} Cards)`;
      const title = prompt("Enter a title for this deck:", defaultTitle);
      if (!title || !title.trim()) return;

      const currentPresetName = PRESET_PROFILES[state.activePreset]?.name || 'Custom Matrix';
      const deckObj = {
        id: 'deck_' + Date.now(),
        subject: currentSubjectName,
        title: title.trim(),
        presetTag: currentPresetName,
        presetKey: state.activePreset,
        activeDimensions: [...state.activeDimensions],
        createdAt: new Date().toISOString(),
        cards: cardsToSave
      };
      await dbSave('decks', deckObj);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      alert(`Saved deck "${deckObj.title}" (${cardsToSave.length} cards).`);
    }

    // ---------------------------------------------------------------------------
    // MASTERY LEDGER, ZERO-GLYPH PDF SANITY GUARD & UI HELPERS
    // ---------------------------------------------------------------------------
    async function updateTopicMastery(topicName, rating, assisted = false) {
      if (!topicName) return "Recorded";
      const cleanTopic = topicName.trim();
      const mId = masteryKey(cleanTopic);
      let record = (await dbGet('mastery', mId)) || {
        id: mId,
        subject: currentSubjectName,
        topic: cleanTopic,
        score: 0,
        status: 'PRACTICING',
        timesTested: 0
      };
      record.timesTested++;
      record.lastTested = new Date().toISOString();

      let deltaStr = "";
      if (rating === 'DEFICIENT') {
        record.score = Math.min(-1, record.score - 2);
        record.status = 'CRITICAL_DRILL';
        deltaStr = `Mastery: -2 (Flagged for Critical Drill)`;
      } else if (rating === 'SATISFACTORY') {
        record.score += assisted ? 0.5 : 1;
        record.status = (record.score >= 4 && !assisted) ? 'MASTERED' : 'PRACTICING';
        deltaStr = assisted ? `Mastery: +0.5 (Assisted)` : `Mastery: +1 (${record.status})`;
      } else if (rating === 'EXCELLENT') {
        record.score += assisted ? 1 : 2;
        record.status = (record.score >= 4 && !assisted) ? 'MASTERED' : 'PRACTICING';
        deltaStr = assisted ? `Mastery: +1 (Assisted)` : `Mastery: +2 (${record.status})`;
      }

      await dbSave('mastery', record);
      await refreshMasteryStatsUI();
      return deltaStr;
    }

    async function refreshMasteryStatsUI() {
      const records = await dbGetAll('mastery');
      let critical = 0, practicing = 0, mastered = 0;
      records.forEach(r => {
        if (r.status === 'CRITICAL_DRILL' || r.score < 0) critical++;
        else if (r.status === 'MASTERED' || r.score >= 4) mastered++;
        else practicing++;
      });
      document.getElementById('statCriticalCount').innerText = critical;
      document.getElementById('statPracticingCount').innerText = practicing;
      document.getElementById('statMasteredCount').innerText = mastered;

      const quickBtn = document.getElementById('quickDrillDeficientBtn');
      const modalBtn = document.getElementById('modalDrillDeficientBtn');
      const headerDefCount = document.getElementById('headerDeficientCount');

      if (critical > 0) {
        quickBtn.classList.remove('hidden');
        modalBtn.classList.remove('hidden');
        headerDefCount.innerText = critical;
      } else {
        quickBtn.classList.add('hidden');
        modalBtn.classList.add('hidden');
      }
    }

    async function resetSubjectMastery() {
      if (confirm(`Reset Weak-Spot Mastery Ledger for ${currentSubjectName}?`)) {
        await dbClearSubjectStore('mastery');
        await refreshMasteryStatsUI();
      }
    }

    async function drillDeficientDirectly() {
      const records = await dbGetAll('mastery');
      const deficient = records.filter(r => r.status === 'CRITICAL_DRILL' || r.score < 0);
      if (deficient.length === 0) {
        alert("No deficient items in ledger!");
        return;
      }

      state.activeAgenda = deficient.map((d, idx) => {
        const isCase = /\s+(?:v\.?|vs\.?)\s+/i.test(d.topic);
        const item = { topic: d.topic, case_title: isCase ? d.topic : undefined, rule_citation: sanitizeCitation(d.topic), isCase };
        const dimObj = assignDimensionToItem(item, idx);
        return { ...item, dimensionId: dimObj.id, dimension: dimObj.label, exportTag: dimObj.exportTag, schemaType: dimObj.schemaType };
      });

      state.totalQuestions = state.activeAgenda.length;
      state.currentQuestionIndex = 1;
      state.sessionTranscript = [];
      state.activeDeckCardsPool = [];

      toggleModal('setupModal');
      document.getElementById('batchIndicatorBadge').innerText = "(Critical Drill)";
      document.getElementById('progressDisplay').classList.remove('hidden');
      document.getElementById('currentQNum').innerText = '1';
      document.getElementById('totalQNum').innerText = state.totalQuestions;

      await launchActiveCard(1);
    }

    function updatePdfProgress(fileLabel, current, total) {
      const wrapper = document.getElementById('pdfProgressWrapper');
      if (!wrapper) return;
      wrapper.classList.remove('hidden');
      const pct = Math.round((current / total) * 100);
      document.getElementById('pdfProgressFileName').innerText = fileLabel;
      document.getElementById('pdfProgressPercent').innerText = `${pct}%`;
      document.getElementById('pdfProgressBar').style.width = `${pct}%`;
      document.getElementById('pdfProgressPageText').innerText = `Extracting Page ${current} of ${total}`;
    }

    function hidePdfProgress() {
      document.getElementById('pdfProgressWrapper')?.classList.add('hidden');
    }

    async function extractTextFromPDF(file, onProgress) {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), useWorkerFetch: false, isEvalSupported: false });
      const pdf = await loadingTask.promise;
      let fullText = '';
      let rawCharCount = 0;
      const totalPages = pdf.numPages;

      for (let p = 1; p <= totalPages; p++) {
        if (onProgress) onProgress(p, totalPages);
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();

        let pageStr = '';
        let lastY = null;
        let lastX = null;

        for (const item of content.items) {
          if (!item.str && item.str !== ' ') continue;
          const str = item.str;
          const trimmed = str.trim();
          const currentX = item.transform ? item.transform[4] : null;
          const currentY = item.transform ? item.transform[5] : null;

          if (currentX !== null && currentX < 18 && trimmed.length <= 1) continue;

          if (trimmed && /^[■•▪♦◦*-]?\s*(?:Doctrine|Facts|Issues?|Ruling)\s*:?$/.test(trimmed)) {
            const cleanLabel = trimmed.replace(/^[■•▪♦◦*-]+\s*/, '').replace(/:$/, '').trim();
            pageStr += `\n■ ${cleanLabel}\n`;
            lastY = currentY;
            lastX = currentX;
            continue;
          }

          if (lastY !== null && currentY !== null) {
            const dy = Math.abs(currentY - lastY);
            const dx = (lastX !== null && currentX !== null) ? (currentX - lastX) : 0;
            if (dy > 13) pageStr += '\n\n' + str;
            else if (dy > 2.8 || dx < -15) pageStr += '\n' + str;
            else pageStr += (pageStr.length > 0 && !pageStr.endsWith('\n') && !pageStr.endsWith(' ') ? ' ' : '') + str;
          } else {
            pageStr += str;
          }
          lastY = currentY;
          lastX = currentX;
        }
        page.cleanup();
        const cleanedPage = pageStr.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
        rawCharCount += cleanedPage.length;
        fullText += `\n[Page ${p}]\n` + cleanedPage;
        if (p % 10 === 0 || p === totalPages) await new Promise(r => setTimeout(r, 0));
      }

      // Zero-Glyph OCR Sanity Guard
      const avgCharsPerPage = totalPages > 0 ? (rawCharCount / totalPages) : 0;
      if (totalPages > 0 && avgCharsPerPage < 30) {
        alert(`⚠️ Warning: "${file.name}" appears to be a scanned image PDF without an embedded text layer (${Math.round(avgCharsPerPage)} chars/page). Please upload an OCR-processed PDF or text file for accurate source grounding.`);
      }

      return { text: fullText.trim(), totalPages };
    }

    async function handleSyllabusFileUpload(event) {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      const status = document.getElementById('syllabusFileStatus');
      status.innerText = "Extracting syllabus...";
      let combined = '', names = [];
      for (const file of files) {
        names.push(file.name);
        if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
          const res = await extractTextFromPDF(file, (curr, tot) => updatePdfProgress(`Syllabus: ${file.name}`, curr, tot));
          combined += res.text;
        } else {
          combined += `\n[${file.name}]\n` + await file.text();
        }
      }
      hidePdfProgress();
      state.syllabusFileName = names.join(', ');
      state.extractedSyllabusText = combined;
      await dbSave('metadata', { key: metaKey('syllabus'), subject: currentSubjectName, name: state.syllabusFileName, text: combined });
      status.innerText = `Saved: ${state.syllabusFileName}`;
      document.getElementById('clearSyllabusBtn').classList.remove('hidden');
      evaluateGatekeeperState();
      event.target.value = '';
    }

    async function clearSavedSyllabus() {
      state.syllabusFileName = '';
      state.extractedSyllabusText = '';
      await dbDelete('metadata', metaKey('syllabus'));
      await dbDelete('metadata', 'syllabus');
      document.getElementById('syllabusFileStatus').innerText = 'No syllabus file attached';
      document.getElementById('clearSyllabusBtn').classList.add('hidden');
      evaluateGatekeeperState();
    }

    async function handleUnifiedSourceUpload(event) {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      document.getElementById('emptySourcesNotice')?.remove();

      for (const file of files) {
        const fileId = `${currentSubjectName}_source_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        let content = '';
        if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
          const res = await extractTextFromPDF(file, (curr, tot) => updatePdfProgress(`Ingesting: ${file.name}`, curr, tot));
          content = res.text;
        } else {
          content = await file.text();
        }
        const item = { id: fileId, subject: currentSubjectName, name: file.name, text: content };
        state.loadedFiles.push(item);
        await dbSave('sources', item);
      }

      hidePdfProgress();
      await buildSearchIndex();
      renderSourcesList();
      evaluateGatekeeperState();
      event.target.value = '';
    }

    function renderSourcesList() {
      const container = document.getElementById('fileListContainer');
      if (!container) return;
      container.innerHTML = '';
      if (state.loadedFiles.length === 0) {
        container.innerHTML = `<div id="emptySourcesNotice" class="text-xs text-slate-400 italic text-center py-2">No reference sources uploaded yet.</div>`;
      } else {
        state.loadedFiles.forEach(f => {
          const div = document.createElement('div');
          div.className = "flex items-center justify-between text-xs bg-slate-900 border border-slate-800 p-2 rounded text-slate-400";
          div.innerHTML = `
            <span class="truncate text-slate-200 font-semibold">${escapeHtml(f.name)}</span>
            <button onclick="removeSource('${f.id}')" class="text-red-400 hover:underline ml-2">✕</button>
          `;
          container.appendChild(div);
        });
      }
      const countEl = document.getElementById('sourceCountBadge');
      if (countEl) countEl.innerText = `${state.loadedFiles.length} Files · ${state.parsedDigests.length} Digests`;
    }

    async function removeSource(id) {
      state.loadedFiles = state.loadedFiles.filter(f => f.id !== id);
      await dbDelete('sources', id);
      await buildSearchIndex();
      renderSourcesList();
      evaluateGatekeeperState();
    }

    async function clearAllSources() {
      if (!confirm(`Remove all uploaded reference files and indexed digests for ${currentSubjectName}?`)) return;
      state.loadedFiles = [];
      state.parsedDigests = [];
      await dbClearSubjectStore('sources');
      await dbClearSubjectStore('digests');
      await buildSearchIndex();
      renderSourcesList();
      evaluateGatekeeperState();
    }

    function applyModelToUI(modelName) {
      const select = document.getElementById('modelSelect');
      const customInput = document.getElementById('customModelInput');
      if (!select) return;
      let found = false;
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === modelName) { select.selectedIndex = i; found = true; break; }
      }
      if (!found && customInput) {
        select.value = '__custom__';
        customInput.value = modelName;
        customInput.classList.remove('hidden');
      } else if (customInput) {
        customInput.classList.add('hidden');
      }
      document.getElementById('activeModelBadge').innerText = modelName;
    }

    function onModelDropdownChanged(val) {
      const customInput = document.getElementById('customModelInput');
      if (val === '__custom__') {
        customInput?.classList.remove('hidden');
        onModelChanged(customInput?.value.trim() || 'gemini-3.8-flash');
      } else {
        customInput?.classList.add('hidden');
        onModelChanged(val);
      }
    }

    function onCustomModelChanged(val) {
      if (val.trim()) onModelChanged(val.trim());
    }

    function onModelChanged(val) {
      state.selectedModel = val;
      localStorage.setItem('bar_gemini_model_universal_v14', val);
      document.getElementById('activeModelBadge').innerText = val;
    }

    async function autoDetectModels(interactive = false) {
      const key = getActiveApiKey();
      if (!key) { if (interactive) alert("Enter an API key first."); return; }
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const allowed = ['gemini-3.8', 'gemini-3.7', 'gemini-3.6', 'gemini-3.5', 'gemini-2.5', 'gemini-1.5', 'gemini-3.1'];
        const validModels = (data.models || []).map(m => m.name.replace('models/', '')).filter(id => allowed.some(f => id.startsWith(f)));

        if (validModels.length > 0) {
          const select = document.getElementById('modelSelect');
          select.innerHTML = '';
          Array.from(new Set(validModels)).forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = id.includes('flash') ? `${id} (Fast · High Quota)` : `${id} (Deep Reasoning)`;
            if (id === state.selectedModel) opt.selected = true;
            select.appendChild(opt);
          });
          const customOpt = document.createElement('option');
          customOpt.value = '__custom__'; customOpt.innerText = 'Custom Model ID...';
          select.appendChild(customOpt);
          applyModelToUI(state.selectedModel);
          if (interactive) alert(`Loaded ${validModels.length} active models.`);
        }
      } catch (err) {
        if (interactive) alert("Detection error: " + err.message);
      }
    }

    function toggleBenchmarkFontSize() {
      state.benchmarkLargeFont = !state.benchmarkLargeFont;
      const box = document.getElementById('benchmarkAlacBox');
      const btn = document.getElementById('fontSizeToggleBtn');
      if (state.benchmarkLargeFont) {
        box.classList.remove('text-sm'); box.classList.add('text-base');
        btn.innerText = 'Text Size: Large (16px)';
      } else {
        box.classList.remove('text-base'); box.classList.add('text-sm');
        btn.innerText = 'Text Size: Standard (14px)';
      }
    }

    function setStudyMode(mode) {
      state.studyMode = mode;
      const aiBtn = document.getElementById('modeAiBtn');
      const cramBtn = document.getElementById('modeCramBtn');
      const submitBtn = document.getElementById('submitAnswerBtn');
      const flipBtn = document.getElementById('flipCardBtn');
      const modeLabel = document.getElementById('modeIndicatorLabel');

      if (mode === 'AI_EXAM') {
        aiBtn.className = "text-xs px-3 py-1 rounded font-mono font-bold transition bg-amber-600 text-slate-950";
        cramBtn.className = "text-xs px-3 py-1 rounded font-mono text-slate-400 hover:text-slate-200 transition";
        submitBtn.classList.remove('hidden');
        flipBtn.classList.add('hidden');
        modeLabel.innerText = "AI EXAM GRADER";
      } else {
        cramBtn.className = "text-xs px-3 py-1 rounded font-mono font-bold transition bg-emerald-600 text-slate-950";
        aiBtn.className = "text-xs px-3 py-1 rounded font-mono text-slate-400 hover:text-slate-200 transition";
        submitBtn.classList.add('hidden');
        flipBtn.classList.remove('hidden');
        modeLabel.innerText = "INSTANT CRAM (0 MS)";
      }
    }

    function saveTypedScope(val) {
      dbSave('metadata', { key: metaKey('typedScope'), subject: currentSubjectName, text: val });
      updateScopePreviewUI(val);
    }

    let editingDebriefIndex = null;

    function renderDebriefTranscriptList() {
      const container = document.getElementById('debriefContent');
      if (!container) return;
      if (!state.sessionTranscript || state.sessionTranscript.length === 0) {
        container.innerHTML = '<div class="text-slate-500 italic text-center py-6">No recitation cards completed in this session yet.</div>';
        return;
      }

      container.innerHTML = state.sessionTranscript.map((t, idx) => {
        const ratingColor = t.rating === 'EXCELLENT' ? 'text-emerald-300 border-emerald-800 bg-emerald-950/40'
          : t.rating === 'SATISFACTORY' ? 'text-amber-300 border-amber-800 bg-amber-950/40'
          : 'text-red-300 border-red-800 bg-red-950/40';

        return `
          <div class="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-slate-100 font-mono text-xs">${idx + 1}. ${escapeHtml(t.topic)}</span>
              <div class="flex items-center space-x-2 shrink-0">
                <span class="px-2 py-0.5 rounded text-[10px] font-mono border ${ratingColor} font-bold">${escapeHtml(t.rating)}</span>
                <button type="button" onclick="openStudioToEditDebriefCard(${idx})" class="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/60 rounded text-[10px] font-mono transition font-semibold" title="Edit prompt and benchmark in transcript">
                  ✏️ Edit
                </button>
              </div>
            </div>
            <div class="space-y-1">
              <p class="text-xs font-semibold text-slate-200">Q: ${escapeHtml(t.question)}</p>
              <p class="text-xs text-slate-400">A: ${escapeHtml(t.studentAnswer)}</p>
            </div>
          </div>
        `;
      }).join('');
    }

    function openDebriefModal() {
      renderDebriefTranscriptList();
      const stats = document.getElementById('debriefSummaryStats');
      if (stats) stats.innerText = `Completed ${state.sessionTranscript.length} cards in this run.`;
      document.getElementById('debriefModal')?.classList.remove('hidden');
    }

    function openStudioToEditDebriefCard(transcriptIndex) {
      if (!state.sessionTranscript || !state.sessionTranscript[transcriptIndex]) return;

      editingDebriefIndex = transcriptIndex;
      const t = state.sessionTranscript[transcriptIndex];
      const card = t.payload || { topic: t.topic, question_text: t.question };

      // Temporarily hide the Debrief modal
      document.getElementById('debriefModal')?.classList.add('hidden');

      // Open the Card Studio modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Pre-fill Title, Citation, and Prompt
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || t.topic || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || t.question || '';

      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Populate Dynamic Sub-fields
      if (card.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = card.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (card.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = card.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = card.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Configure Modal Actions
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Debrief Card";

      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    async function applyDebriefCardUpdate() {
      if (editingDebriefIndex === null || !state.sessionTranscript[editingDebriefIndex]) return;

      const t = state.sessionTranscript[editingDebriefIndex];
      const payload = t.payload || {};

      const topic = document.getElementById('customTopicInput')?.value.trim() || t.topic || '';
      const citation = document.getElementById('customCitationInput')?.value.trim() || '';
      const question = document.getElementById('customQuestionPromptInput')?.value.trim() || t.question || '';

      t.topic = topic;
      t.question = question;
      payload.topic = topic;
      payload.citation = citation;
      payload.rule_citation = citation;
      payload.question_text = question;

      const archetype = currentCardArchetype || 'CODAL';

      if (archetype === 'CASE') {
        payload.benchmark_fir = {
          facts: document.getElementById('caseFactsInput')?.value.trim() || '',
          issue: document.getElementById('caseIssueInput')?.value.trim() || '',
          ruling: document.getElementById('caseRulingInput')?.value.trim() || '',
          ratio_doctrine: document.getElementById('caseRatioInput')?.value.trim() || ''
        };
      } else if (archetype === 'CODAL') {
        payload.benchmark_codal_breakdown = {
          operative_rule_summary: document.getElementById('codalRuleInput')?.value.trim() || '',
          elements_requisites: document.getElementById('codalRequisitesInput')?.value.trim() || '',
          statutory_exceptions: document.getElementById('codalStatExceptionsInput')?.value.trim() || '',
          jurisprudential_exceptions: document.getElementById('codalJurisExceptionsInput')?.value.trim() || '',
          application_ratio: payload.benchmark_codal_breakdown?.application_ratio || ''
        };
        payload.codal_provision_text = payload.benchmark_codal_breakdown.operative_rule_summary;
      } else if (archetype === 'ALAC') {
        payload.benchmark_alac = {
          p1_direct_answer: document.getElementById('alacAInput')?.value.trim() || '',
          p2_legal_basis: document.getElementById('alacLInput')?.value.trim() || '',
          p3_analysis: document.getElementById('alacAppInput')?.value.trim() || '',
          p4_conclusion: document.getElementById('alacCInput')?.value.trim() || ''
        };
      } else {
        payload.answer = document.getElementById('simpleAnswerInput')?.value.trim() || '';
        payload.model_answer = payload.answer;
      }

      t.payload = payload;

      // Close Card Studio
      document.getElementById('cardCreatorModal')?.classList.add('hidden');
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Save Card";
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.remove('hidden');

      // Re-open and re-render Debrief modal
      editingDebriefIndex = null;
      openDebriefModal();
    }

    function toggleModal(id) {
      if (id === 'debriefModal' && document.getElementById('debriefModal')?.classList.contains('hidden')) {
        openDebriefModal();
        return;
      }
      document.getElementById(id).classList.toggle('hidden');
    }
    function updateWordCount() {
      const text = document.getElementById('studentAnswer').value.trim();
      document.getElementById('wordCount').innerText = `${text ? text.split(/\s+/).length : 0} words`;
    }

    function handleAnswerKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (state.studyMode === 'AI_EXAM') submitStudentAnswer();
        else revealInstantCramCard();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (typeof editActiveCardInPlace === 'function') editActiveCardInPlace(false);
      }
    }

    // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal

     

    // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal
    let isEditingFromEvaluation = false;

    // Global keyboard listener for modal navigation and post-flip editing
    window.addEventListener('keydown', (e) => {
      const evalModal = document.getElementById('evalModal');
      const isEvalOpen = evalModal && !evalModal.classList.contains('hidden');
      const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

      if (isEvalOpen && !isTyping) {
        if (e.key === 'e' || e.key === 'E') {
          e.preventDefault();
          if (typeof editActiveCardInPlace === 'function') editActiveCardInPlace(true);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          proceedToNextQuestion();
        }
      }
    });

     // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal

    function editActiveCardInPlace(fromEvaluation = false) {
      const card = state.activeCardItem;
      if (!card) {
        alert("No active card currently selected to edit.");
        return;
      }

      isEditingFromEvaluation = fromEvaluation;

      // Close evaluation modal if open so the user can edit cleanly
      if (fromEvaluation) {
        const evalModal = document.getElementById('evalModal');
        if (evalModal) evalModal.classList.add('hidden');
      }

      // Open the Card Creator modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Title & Topic Fields
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || state.currentQuestionText || '';

      const pkg = state.currentBenchmarkPayload || card;
      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Determine Archetype & Pre-populate Dynamic Sub-fields
      if (pkg.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = pkg.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (pkg.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = pkg.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (pkg.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = pkg.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Update button label to indicate In-Place Update mode
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Card In Place";

      // Hide "Save & Add Another" during in-place editing to prevent duplicate insertions
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal

    function editActiveCardInPlace(fromEvaluation = false) {
      const card = state.activeCardItem;
      if (!card) {
        alert("No active card currently selected to edit.");
        return;
      }

      isEditingFromEvaluation = fromEvaluation;

      // Close evaluation modal if open so the user can edit cleanly
      if (fromEvaluation) {
        const evalModal = document.getElementById('evalModal');
        if (evalModal) evalModal.classList.add('hidden');
      }

      // Open the Card Creator modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Title & Topic Fields
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || state.currentQuestionText || '';

      const pkg = state.currentBenchmarkPayload || card;
      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Determine Archetype & Pre-populate Dynamic Sub-fields
      if (pkg.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = pkg.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (pkg.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = pkg.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (pkg.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = pkg.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Update button label to indicate In-Place Update mode
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Card In Place";

      // Hide "Save & Add Another" during in-place editing to prevent duplicate insertions
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal

    function editActiveCardInPlace(fromEvaluation = false) {
      const card = state.activeCardItem;
      if (!card) {
        alert("No active card currently selected to edit.");
        return;
      }

      isEditingFromEvaluation = fromEvaluation;

      // Close evaluation modal if open so the user can edit cleanly
      if (fromEvaluation) {
        const evalModal = document.getElementById('evalModal');
        if (evalModal) evalModal.classList.add('hidden');
      }

      // Open the Card Creator modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Title & Topic Fields
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || state.currentQuestionText || '';

      const pkg = state.currentBenchmarkPayload || card;
      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Determine Archetype & Pre-populate Dynamic Sub-fields
      if (pkg.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = pkg.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (pkg.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = pkg.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (pkg.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = pkg.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Update button label to indicate In-Place Update mode
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Card In Place";

      // Hide "Save & Add Another" during in-place editing to prevent duplicate insertions
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal

    function editActiveCardInPlace(fromEvaluation = false) {
      const card = state.activeCardItem;
      if (!card) {
        alert("No active card currently selected to edit.");
        return;
      }

      isEditingFromEvaluation = fromEvaluation;

      // Close evaluation modal if open so the user can edit cleanly
      if (fromEvaluation) {
        const evalModal = document.getElementById('evalModal');
        if (evalModal) evalModal.classList.add('hidden');
      }

      // Open the Card Creator modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Title & Topic Fields
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || state.currentQuestionText || '';

      const pkg = state.currentBenchmarkPayload || card;
      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Determine Archetype & Pre-populate Dynamic Sub-fields
      if (pkg.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = pkg.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (pkg.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = pkg.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (pkg.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = pkg.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Update button label to indicate In-Place Update mode
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Card In Place";

      // Hide "Save & Add Another" during in-place editing to prevent duplicate insertions
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    // Tracks if editing was initiated post-flip so Part 2C can re-open #evalModal

    function editActiveCardInPlace(fromEvaluation = false) {
      const card = state.activeCardItem;
      if (!card) {
        alert("No active card currently selected to edit.");
        return;
      }

      isEditingFromEvaluation = fromEvaluation;

      // Close evaluation modal if open so the user can edit cleanly
      if (fromEvaluation) {
        const evalModal = document.getElementById('evalModal');
        if (evalModal) evalModal.classList.add('hidden');
      }

      // Open the Card Creator modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Title & Topic Fields
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || state.currentQuestionText || '';

      const pkg = state.currentBenchmarkPayload || card;
      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Determine Archetype & Pre-populate Dynamic Sub-fields
      if (pkg.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = pkg.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (pkg.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = pkg.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (pkg.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = pkg.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Update button label to indicate In-Place Update mode
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Card In Place";

      // Hide "Save & Add Another" during in-place editing to prevent duplicate insertions
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    function setupTimer() {
      clearInterval(state.timerInterval);
      state.timerSeconds = state.timerDefault;
      updateTimerDisplay();
      if (state.timerDefault > 0) {
        state.timerRunning = true;
        document.getElementById('timerToggleBtn').innerText = 'Pause';
        state.timerInterval = setInterval(() => {
          if (state.timerRunning && state.timerSeconds > 0) {
            state.timerSeconds--;
            updateTimerDisplay();
            if (state.timerSeconds === 0) {
              clearInterval(state.timerInterval);
              document.getElementById('timerDisplay').innerText = "00:00 (Time)";
            }
          }
        }, 1000);
      } else {
        document.getElementById('timerDisplay').innerText = "Untimed";
        document.getElementById('timerToggleBtn').innerText = "";
      }
    }

    function toggleTimer() {
      state.timerRunning = !state.timerRunning;
      document.getElementById('timerToggleBtn').innerText = state.timerRunning ? 'Pause' : 'Resume';
    }

    function updateTimerDisplay() {
      const min = Math.floor(state.timerSeconds / 60);
      const sec = state.timerSeconds % 60;
      document.getElementById('timerDisplay').innerText = `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    async function exportSessionMarkdown() {
      if (!state.sessionTranscript || state.sessionTranscript.length === 0) {
        alert("No transcript to export.");
        return;
      }
      const stripBolds = (str) => (str || '').replace(/\*\*/g, '').trim();
      let md = '';

      state.sessionTranscript.forEach((t, i) => {
        const qNum = i + 1;
        const headerLine = formatExportQuestionHeader(t.payload || { topic: t.topic }, qNum);
        md += `**${headerLine}**\n\n`;
        md += `**${stripBolds(t.question)}**\n\n`;
        const paras = extractCardParagraphsForExport(t.payload || {});
        md += paras.join('\n\n') + `\n\n---\n\n`;
      });

      const fileName = `${currentSubjectName}_Universal_Session_${new Date().toISOString().slice(0, 10)}.md`;
      await exportWithSaveDialog(
        '\uFEFF' + md,
        fileName,
        'text/markdown;charset=utf-8',
        'Markdown Session Transcript (.md)',
        '.md'
      );
    }

    async function exportWorkspaceJSON() {
      const meta = await dbGetAllRaw('metadata');
      const sources = await dbGetAllRaw('sources');
      const digests = await dbGetAllRaw('digests');
      const mastery = await dbGetAllRaw('mastery');
      const decks = await dbGetAllRaw('decks');
      const payload = {
        exportVersion: "14.1_universal_master_db",
        exportDate: new Date().toISOString(),
        subject: currentSubjectName,
        activeModel: state.selectedModel,
        activeDimensions: state.activeDimensions,
        apiKeys: localStorage.getItem('bar_gemini_api_keys') || '',
        metadata: meta,
        sources: sources,
        digests: (decks && decks.length >= 15) ? [] : digests,
        mastery: mastery,
        decks: decks
      };
      
      const fileName = `UniversalBarSimulator_Master_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      const jsonContent = JSON.stringify(payload, null, 2);

      await exportWithSaveDialog(
        jsonContent,
        fileName,
        'application/json',
        'Universal Master Database Backup (.json)',
        '.json'
      );
    }

    async function handleWorkspaceImport(event) {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const importedSub = data.subject || currentSubjectName;

        if (data.apiKeys) {
          localStorage.setItem('bar_gemini_api_keys', data.apiKeys);
          document.getElementById('apiKeyInput').value = data.apiKeys;
          parseApiKeys(data.apiKeys);
        }

        // Restore custom dimensions from backup if present
        if (data.activeDimensions && Array.isArray(data.activeDimensions)) {
          state.activeDimensions = data.activeDimensions;
          localStorage.setItem('bar_universal_dims_' + importedSub, JSON.stringify(data.activeDimensions));
          syncDimensionCheckboxesToState();
        }

        for (const m of data.metadata || []) {
          const normKey = m.key && m.key.includes('::') ? m.key : `${m.subject || importedSub}::${m.key}`;
          await dbSave('metadata', { ...m, key: normKey, subject: m.subject || importedSub });
        }
        for (const s of data.sources || []) {
          await dbSave('sources', { ...s, subject: s.subject || importedSub });
        }
        for (const dig of data.digests || []) {
          await dbSave('digests', { ...dig, subject: dig.subject || importedSub });
        }
        for (const mas of data.mastery || []) {
          const normId = mas.id || `${mas.subject || importedSub}::${mas.topic}`;
          await dbSave('mastery', { ...mas, id: normId, subject: mas.subject || importedSub });
        }
        for (const d of data.decks || []) {
          await dbSave('decks', { ...d, subject: d.subject || importedSub });
        }

        state.loadedFiles = await dbGetAll('sources');
        state.parsedDigests = await dbGetAll('digests');

        const savedSyllabus = await dbGet('metadata', metaKey('syllabus'));
        if (savedSyllabus) {
          state.syllabusFileName = savedSyllabus.name;
          state.extractedSyllabusText = savedSyllabus.text;
          document.getElementById('syllabusFileStatus').innerText = `Saved: ${savedSyllabus.name}`;
          document.getElementById('clearSyllabusBtn')?.classList.remove('hidden');
        }

        const savedScope = await dbGet('metadata', metaKey('typedScope'));
        if (savedScope) {
          document.getElementById('typedScopeInput').value = savedScope.text;
        }

        await buildSearchIndex();
        renderSourcesList();
        await refreshMasteryStatsUI();
        await renderDeckListUI();
        evaluateGatekeeperState();
        alert("Universal Master Backup restored and merged successfully!");
      } catch (e) {
        alert("Import failed: " + e.message);
      } finally {
        event.target.value = '';
      }
    }// ---------------------------------------------------------------------------
    // CROSS-DEVICE DISK SYNC SUBSYSTEM (OPTION A DIFF & BACKGROUND CHECK)
    // ---------------------------------------------------------------------------
    let pendingExternalSyncPayload = null;
    let syncScanInterval = null;

    function getSyncFileNameForSubject(sub) {
      const clean = (sub || currentSubjectName).replace(/[^a-zA-Z0-9_-]/g, '_');
      return `BarRecit_${clean}_Sync.json`;
    }

    async function stampSubjectModifiedTimestamp() {
      const now = Date.now();
      await dbSave('metadata', {
        key: metaKey('lastModifiedTimestamp'),
        subject: currentSubjectName,
        val: now
      });
      await autoSaveSubjectToTauriDisk();

      // Workspace state stamped locally; PIN-based snapshot relay active

      return now;
    }

    async function generateSubjectSyncPayload() {
      const meta = await dbGetAll('metadata');
      const sources = await dbGetAll('sources');
      const digests = await dbGetAll('digests');
      const mastery = await dbGetAll('mastery');
      const decks = await dbGetAll('decks');

      return {
        exportVersion: "14.1_subject_sync",
        exportDate: new Date().toISOString(),
        subject: currentSubjectName,
        activeModel: state.selectedModel,
        activeDimensions: state.activeDimensions,
        metadata: meta,
        sources: sources,
        digests: (decks && decks.length >= 15) ? [] : digests,
        mastery: mastery,
        decks: decks
      };
    }

    async function checkForModernDiskSync(subjectName = currentSubjectName) {
      if (state.isSessionActive) return;
      if (!window.__TAURI__?.core) return;

      const fileName = getSyncFileNameForSubject(subjectName);

      try {
        const meta = await window.__TAURI__.core.invoke('check_subject_sync_status', { file_name: fileName });
        if (!meta || !meta.exists) return;

        const localMeta = await dbGet('metadata', metaKey('lastModifiedTimestamp'));
        const localTimestamp = localMeta ? (localMeta.val || 0) : 0;

        if (meta.modified_timestamp_ms > localTimestamp + 2000) {
          const rawJson = await window.__TAURI__.core.invoke('read_subject_sync_file', { file_name: fileName });
          pendingExternalSyncPayload = JSON.parse(rawJson);
          showExternalUpdateBanner(meta, localTimestamp);
        }
      } catch (err) {
        console.warn("Background sync warning:", err);
      }
    }

    function showExternalUpdateBanner(meta, localTimestamp) {
      const banner = document.getElementById('externalUpdateBanner');
      const subBadge = document.getElementById('externalUpdateSubject');
      const notice = document.getElementById('externalUpdateNotice');
      if (!banner || !subBadge || !notice) return;

      subBadge.innerText = currentSubjectName;
      const localDateStr = localTimestamp > 0 ? new Date(localTimestamp).toLocaleTimeString() : 'Initial State';
      const diskDateStr = new Date(meta.modified_timestamp_ms).toLocaleTimeString();

      notice.innerHTML = `Disk file was updated at <b>${diskDateStr}</b> (${meta.deck_count} decks, ${meta.mastery_count} mastery entries). Local workspace stamped at <b>${localDateStr}</b>.`;
      banner.classList.remove('hidden');
    }

    function dismissSyncNotification() {
      const banner = document.getElementById('externalUpdateBanner');
      if (banner) banner.classList.add('hidden');
      pendingExternalSyncPayload = null;
    }

    // Option A Summary Diff Modal
    async function inspectExternalSyncFile() {
      if (!pendingExternalSyncPayload) return;
      const p = pendingExternalSyncPayload;

      const localDecks = await dbGetAll('decks');
      const localDeckIds = new Set(localDecks.map(d => d.id));
      const incomingDecks = p.decks || [];
      
      let newDeckCount = 0;
      let updateDeckCount = 0;
      const newDeckTitles = [];

      incomingDecks.forEach(d => {
        if (localDeckIds.has(d.id)) {
          updateDeckCount++;
        } else {
          newDeckCount++;
          if (newDeckTitles.length < 3) newDeckTitles.push(d.title);
        }
      });

      const localMastery = await dbGetAll('mastery');
      const localMasteryMap = new Map(localMastery.map(m => [m.id, m]));
      const incomingMastery = p.mastery || [];

      let masteryScoreUpdates = 0;
      let newMasteryEntries = 0;

      incomingMastery.forEach(m => {
        const existing = localMasteryMap.get(m.id);
        if (!existing) {
          newMasteryEntries++;
        } else {
          const existingTime = new Date(existing.lastTested || 0).getTime();
          const incomingTime = new Date(m.lastTested || 0).getTime();
          if (incomingTime > existingTime && m.score !== existing.score) {
            masteryScoreUpdates++;
          }
        }
      });

      const sampleText = newDeckTitles.length > 0 
        ? `\n  • ${newDeckTitles.join('\n  • ')}${newDeckCount > 3 ? `\n  • ...and ${newDeckCount - 3} more` : ''}` 
        : ' None (all match existing IDs)';

      const summary = 
        `========================================\n` +
        `  SYNC DIFFERENCE SUMMARY: ${p.subject}\n` +
        `========================================\n\n` +
        `[DECKS]\n` +
        `• New Decks to Add: ${newDeckCount}${sampleText}\n` +
        `• Existing Decks to Refresh: ${updateDeckCount}\n` +
        `• Current Local Decks Kept: ${localDecks.length} (Protected)\n\n` +
        `[MASTERY PROGRESS]\n` +
        `• New Card History Entries: ${newMasteryEntries}\n` +
        `• Topic Scores to Advance: ${masteryScoreUpdates}\n\n` +
        `[FILE INFO]\n` +
        `• Exported At: ${p.exportDate ? new Date(p.exportDate).toLocaleString() : 'Unknown'}\n\n` +
        `Click "Import & Update Workspace" to apply these updates non-destructively.`;

      alert(summary);
    }

    async function applyExternalSyncImport() {
      if (!pendingExternalSyncPayload) return;
      const p = pendingExternalSyncPayload;

      for (const incomingDeck of p.decks || []) {
        await dbSave('decks', { ...incomingDeck, subject: currentSubjectName });
      }

      for (const incoming of p.mastery || []) {
        const existing = await dbGet('mastery', incoming.id);
        if (!existing) {
          await dbSave('mastery', { ...incoming, subject: currentSubjectName });
        } else {
          const existingTime = new Date(existing.lastTested || 0).getTime();
          const incomingTime = new Date(incoming.lastTested || 0).getTime();
          if (incomingTime >= existingTime) {
            await dbSave('mastery', { ...incoming, subject: currentSubjectName });
          }
        }
      }

      for (const m of p.metadata || []) {
        if (!m.key.includes('lastModifiedTimestamp')) {
          await dbSave('metadata', { ...m, subject: currentSubjectName });
        }
      }

      await stampSubjectModifiedTimestamp();
      dismissSyncNotification();
      await refreshMasteryStatsUI();
      await renderDeckListUI();
      evaluateGatekeeperState();

      alert(`Workspace successfully updated! Local decks were preserved.`);
    }

    async function autoSaveSubjectToTauriDisk() {
      if (!window.__TAURI__?.core) return;

      const cleanSub = currentSubjectName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `BarRecit_${cleanSub}_Sync.json`;
      const payload = await generateSubjectSyncPayload();

      try {
        await window.__TAURI__.core.invoke('save_subject_sync_file', {
          file_name: fileName,
          content: JSON.stringify(payload, null, 2)
        });
      } catch (err) {
        console.warn("Tauri auto-save notice:", err);
      }
    }

    async function revealAndShowFileMetrics() {
      const fileName = getSyncFileNameForSubject();
      const toast = document.getElementById('fileMetricToast');

      await autoSaveSubjectToTauriDisk();

      if (window.__TAURI__?.core) {
        try {
          const meta = await window.__TAURI__.core.invoke('check_subject_sync_status', { file_name: fileName });
          await window.__TAURI__.core.invoke('open_sync_directory');

          if (toast && meta) {
            toast.classList.remove('hidden');
            toast.innerHTML = `✓ <b>${fileName}</b> revealed in File Explorer<br><span class="text-slate-300 text-[11px]">Decks: ${meta.deck_count} · Mastery Entries: ${meta.mastery_count}</span>`;
          }
        } catch (err) {
          alert("Could not open file manager: " + err);
        }
      } else {
        // Direct browser fallback: Download the file immediately
        const payload = await generateSubjectSyncPayload();
        const jsonStr = JSON.stringify(payload, null, 2);
        const sizeKb = (new Blob([jsonStr]).size / 1024).toFixed(1);
        const totalCards = (payload.decks || []).reduce((acc, d) => acc + (d.cards ? d.cards.length : 0), 0);

        const blob = new Blob([jsonStr], { type: 'application/json' });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();

        if (toast) {
          toast.classList.remove('hidden');
          toast.innerHTML = `✓ <b>${fileName}</b> downloaded directly: <b>${sizeKb} KB</b> (${payload.decks.length} Decks · ${totalCards} Cards)`;
        }
      }
    }

    async function openGoogleAIStudioKeyPage() {
      const url = 'https://aistudio.google.com/app/apikey';
      if (window.__TAURI__?.core) {
        try {
          await window.__TAURI__.core.invoke('open_url', { url });
        } catch (_) {
          window.open(url, '_blank');
        }
      } else {
        window.open(url, '_blank');
      }
    }

    function dismissTutorialModal() {
      const checkbox = document.getElementById('dontShowTutorialAgain');
      if (checkbox && checkbox.checked) {
        localStorage.setItem('bar_has_seen_tutorial', 'true');
      }
      document.getElementById('tutorialModal').classList.add('hidden');
      // Smoothly transition the user into the configuration modal
      document.getElementById('setupModal')?.classList.remove('hidden');
    }
// =========================================================================
    // VIDEO MODAL & AUTONOMOUS TOUR ENGINE (10-STEP STREAMLINED FLOW)
    // =========================================================================
    let isTourRunning = false;
    window._activeUtterances = [];

    function openVideoTutorialModal() {
      document.getElementById('videoTutorialModal')?.classList.remove('hidden');
    }

    function closeVideoModal() {
      const vid = document.getElementById('tutorialVideoPlayer');
      if (vid) vid.pause();
      const checkbox = document.getElementById('dontShowVideoAgain');
      if (checkbox && checkbox.checked) {
        localStorage.setItem('bar_has_seen_video_tutorial', 'true');
      }
      document.getElementById('videoTutorialModal')?.classList.add('hidden');
    }

    async function typeSimulatedText(element, text, speedMs = 30) {
      if (!element) return;
      element.value = '';
      for (let i = 0; i < text.length; i++) {
        if (!isTourRunning) return;
        element.value += text[i];
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, speedMs));
      }
    }

    function speakNarration(text) {
      return new Promise((resolve) => {
        if (!window.speechSynthesis) {
          setTimeout(resolve, 3500);
          return;
        }

        window.speechSynthesis.cancel();
        window._activeUtterances = [];

        const clauses = text.match(/[^,.;:]+[,.;:]?/g) || [text];
        let clauseIdx = 0;

        function speakNextClause() {
          if (!isTourRunning || clauseIdx >= clauses.length) {
            resolve();
            return;
          }

          const clauseText = clauses[clauseIdx].trim();
          clauseIdx++;

          if (!clauseText) {
            speakNextClause();
            return;
          }

          const utterance = new SpeechSynthesisUtterance(clauseText);
          utterance.rate = 1.0;
          utterance.pitch = 1.0;

          const clauseWords = clauseText.split(/\s+/).length;
          const clauseTimeout = setTimeout(() => {
            speakNextClause();
          }, Math.max(4000, (clauseWords * 600) + 2000));

          utterance.onend = () => {
            clearTimeout(clauseTimeout);
            speakNextClause();
          };

          utterance.onerror = () => {
            clearTimeout(clauseTimeout);
            speakNextClause();
          };

          window._activeUtterances.push(utterance);
          window.speechSynthesis.speak(utterance);
        }

        speakNextClause();
      });
    }

    async function launchInteractiveTour() {
      if (isTourRunning) return;
      isTourRunning = true;

      const setupModal = document.getElementById('setupModal');
      if (setupModal && setupModal.classList.contains('hidden')) {
        toggleModal('setupModal');
        // Allow modal DOM layout to settle before starting steps
        await new Promise(r => setTimeout(r, 400));
      }

      let spotlight = document.getElementById('tourSpotlight');
      if (!spotlight) {
        spotlight = document.createElement('div');
        spotlight.id = 'tourSpotlight';
        spotlight.style = `
          position: fixed;
          z-index: 10000;
          pointer-events: none;
          border-radius: 8px;
          border: 2px solid #f59e0b;
          box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.85);
          transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        `;
        document.body.appendChild(spotlight);
      }

      let hud = document.getElementById('tourHud');
      if (!hud) {
        hud = document.createElement('div');
        hud.id = 'tourHud';
        hud.style = `
          position: fixed;
          z-index: 10001;
          left: 50%;
          transform: translateX(-50%);
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 12px 20px;
          min-width: 380px;
          max-width: 520px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.85);
          font-family: sans-serif;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          transition: top 0.3s ease, bottom 0.3s ease;
        `;
        hud.innerHTML = `
          <div style="flex: 1;">
            <div id="hudStepBadge" style="font-size: 10px; font-weight: bold; color: #f59e0b; text-transform: uppercase; font-family: monospace;">Step 1 of 10</div>
            <div id="hudText" style="font-size: 12px; color: #f8fafc; font-weight: 500; margin-top: 2px; line-height: 1.4;">Starting walkthrough...</div>
          </div>
          <button type="button" onclick="stopInteractiveTour()" style="background: #334155; color: #e2e8f0; border: none; padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer;">Exit</button>
        `;
        document.body.appendChild(hud);
      }

      const tourSteps = [
        {
          elementId: 'apiKeyInput',
          badge: "Step 1: API Key Configuration",
          narration: "First, generate a free Gemini API key from Google AI Studio using a personal Gmail account, and paste it into the API key field.",
          action: async (el) => {
            await typeSimulatedText(el, "AIzaSy_FreeTierKey_DemoExample");
          }
        },
        {
          elementId: 'setupSubjectSelector',
          badge: "Step 2: Subject Workspace",
          narration: "Select the specific law subject you are studying from the dropdown menu, or create a custom subject workspace to keep your syllabus and decks organized.",
          action: async (el) => {
            el.focus();
            await new Promise(r => setTimeout(r, 500));
          }
        },
        {
          elementId: 'syllabusDropzone',
          badge: "Step 3: Upload Course Syllabus (Anchor 1)",
          narration: "In Anchor 1, attach your course syllabus PDF. The parser extracts modules, codal sections, and Supreme Court case titles automatically.",
          action: async () => {}
        },
        {
          elementId: 'sourcesDropzone',
          badge: "Step 4: Upload Reference Sources (Anchor 2)",
          narration: "In Anchor 2, upload your reference case digests and codals. Matched doctrines load in zero milliseconds without using API quota.",
          action: async () => {}
        },
        {
          elementId: 'typedScopeInput',
          badge: "Step 5: Target Coverage Scope",
          narration: "Type the specific syllabus module, section range, or assigned cases you want to be examined on in the coverage box.",
          action: async (el) => {
            await typeSimulatedText(el, "Rule 130 Section 37-50, Dying Declaration, Fabillar v. Paller");
          }
        },
        {
          elementId: 'presetsGridContainer',
          badge: "Step 6: Recitation Dimension Presets",
          narration: "Select your drill preset: Codal Mode for statutory provisions, Case Facts, Issue, and Ruling Mode for doctrines, Reviewer Mode for distinctions, or Full Bar Simulator for all the presets combined.",
          action: async () => {
            applyDimensionPreset('ALL');
          }
        },
        {
          elementId: 'footerPreCompileBtn',
          badge: "Step 7: Pre-Compile Deck",
          narration: "Click Pre-Compile to synthesize all question batches and authoritative benchmark breakdowns into your offline database and click okay to save the deck",
          action: async () => {}
        },
        {
          elementId: 'savedDecksSection',
          badge: "Step 8: Saved Decks & Flashcard Exports",
          narration: "Your compiled cards are saved in the Decks Library. Here you can launch any saved deck, export cards as JSON to share with classmates, or download formatted Word and Markdown study sheets.",
          action: async () => {}
        },
        {
          elementId: 'masterBackupSection',
          badge: "Step 9: Master Database Backup & Sync",
          narration: "When switching between your laptop and phone, use Export Master Backup and Import Backup to migrate your entire database, decks, and weak-spot scores.",
          action: async () => {}
        },
        {
          elementId: 'footerLaunchBtn',
          badge: "Step 10: Launch Active Batch",
          narration: "Finally, click Launch Active Batch to enter the oral recitation arena, test your recall against the AI examiner, and drill your questions.",
          action: async () => {}
        }
      ];

      await new Promise(r => setTimeout(r, 250));

      for (let i = 0; i < tourSteps.length; i++) {
        if (!isTourRunning) break;
        const step = tourSteps[i];
        let el = document.getElementById(step.elementId);

        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 400));

          const rect = el.getBoundingClientRect();
          spotlight.style.top = `${Math.max(8, rect.top - 4)}px`;
          spotlight.style.left = `${Math.max(8, rect.left - 4)}px`;
          spotlight.style.width = `${Math.min(window.innerWidth - 16, rect.width + 8)}px`;
          spotlight.style.height = `${rect.height + 8}px`;

          if (rect.bottom > window.innerHeight - 140) {
            hud.style.bottom = 'auto';
            hud.style.top = '24px';
          } else {
            hud.style.top = 'auto';
            hud.style.bottom = '24px';
          }

          document.getElementById('hudStepBadge').innerText = step.badge;
          document.getElementById('hudText').innerText = step.narration;

          await Promise.all([
            step.action(el),
            speakNarration(step.narration)
          ]);
        }
        await new Promise(r => setTimeout(r, 650));
      }

      stopInteractiveTour();
    }

    function stopInteractiveTour() {
      isTourRunning = false;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      window._activeUtterances = [];
      document.getElementById('tourSpotlight')?.remove();
      document.getElementById('tourHud')?.remove();
    }

    // =========================================================================
    // UNIVERSAL "SAVE AS" FILE EXPORTER (TAURI DESKTOP + BROWSER PICKER + MOBILE)
    // =========================================================================
    async function exportWithSaveDialog(content, defaultFilename, mimeType, description, extension) {
      // 1. Native Tauri v2 Environment
      if (window.__TAURI__?.dialog && (window.__TAURI__?.fs || window.__TAURI__?.core)) {
        try {
          const filePath = await window.__TAURI__.dialog.save({
            defaultPath: defaultFilename,
            filters: [{
              name: description,
              extensions: [extension.replace('.', '')]
            }]
          });

          if (filePath) {
            if (window.__TAURI__.fs?.writeTextFile) {
              await window.__TAURI__.fs.writeTextFile(filePath, content);
            } else if (window.__TAURI__.core?.invoke) {
              await window.__TAURI__.core.invoke('plugin:fs|write_file', {
                path: filePath,
                contents: Array.from(new TextEncoder().encode(content))
              });
            }
            alert(`File saved:\n${filePath}`);
            return;
          } else {
            return; // User canceled the picker
          }
        } catch (err) {
          console.warn("Tauri native dialog failed, attempting browser picker:", err);
        }
      }

      // 2. Modern Desktop Web Browsers (Chrome, Edge, Brave - File System Access API)
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: defaultFilename,
            types: [{
              description: description,
              accept: { [mimeType]: [extension] }
            }]
          });
          const writable = await handle.createWritable();
          await writable.write(content);
          await writable.close();
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          console.warn("File System Access API failed, falling back to download:", err);
        }
      }

      // 3. Fallback for Safari, iOS, and Mobile (Direct Blob Download)
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    // Automatically retrieves active cards from state pools or local storage
    async function getActiveCards() {
      if (state.activeDeckCardsPool && state.activeDeckCardsPool.length) return state.activeDeckCardsPool;
      if (state.activeAgenda && state.activeAgenda.length) return state.activeAgenda;
      if (state.allUnbundledPool && state.allUnbundledPool.length) return state.allUnbundledPool;
      if (typeof currentDeckCards !== 'undefined' && currentDeckCards?.length) return currentDeckCards;
      if (typeof allCards !== 'undefined' && allCards?.length) return allCards;
      if (typeof cards !== 'undefined' && cards?.length) return cards;
      
      const stored = localStorage.getItem('bar_recitation_cards') || localStorage.getItem('cards') || localStorage.getItem('deck');
      if (stored) {
        try { return JSON.parse(stored); } catch (e) {}
      }
      return [];
    }

    // Universal single-click trigger for floating toolbar
    function exportDeck(format) {
      const activeCards = getActiveCards();
      if (!activeCards || activeCards.length === 0) {
        alert("No flashcards found to export. Launch or pre-compile a deck first.");
        return;
      }
      if (format === 'json') exportCardsAsJSON(activeCards);
      if (format === 'md') exportCardsAsMarkdown(activeCards);
      if (format === 'doc') exportCardsAsDoc(activeCards);
    }

// 1. Export as JSON
async function exportCardsAsJSON(cardsArray) {
      if (!cardsArray || cardsArray.length === 0) {
        alert("No flashcards found to export.");
        return;
      }
      const jsonString = JSON.stringify(cardsArray, null, 2);
      await exportWithSaveDialog(
        jsonString,
        'Bar_Recitation_Decks.json',
        'application/json',
        'JSON Deck File',
        '.json'
      );
    }

    // 2. Export as Markdown (using native syllabus formatters)
    async function exportCardsAsMarkdown(cardsArray) {
      if (!cardsArray || cardsArray.length === 0) {
        alert("No flashcards found to export.");
        return;
      }
      let md = `# Philippine Bar Recitation Deck\n*Generated on: ${new Date().toLocaleDateString()}*\n\n---\n\n`;
      cardsArray.forEach((card, index) => {
        const qNum = index + 1;
        const header = typeof formatExportQuestionHeader === 'function' 
          ? formatExportQuestionHeader(card, qNum) 
          : `Question ${qNum}: ${card.topic || card.title || 'Bar Review Topic'}`;
        const question = card.question_text || card.question || card.front || '';
        
        md += `**${header}**\n\n`;
        if (question) md += `**${question}**\n\n`;

        if (typeof extractCardParagraphsForExport === 'function') {
          const paras = extractCardParagraphsForExport(card);
          if (paras && paras.length) {
            md += paras.join('\n\n') + '\n\n';
          }
        } else {
          const ans = card.answer || card.back || '';
          if (ans) md += `${ans}\n\n`;
          if (card.citation) md += `*Legal Basis / Citation:* \`${card.citation}\`\n\n`;
        }
        md += `---\n\n`;
      });

      await exportWithSaveDialog(
        md,
        'Bar_Recitation_Cards.md',
        'text/markdown',
        'Markdown Document',
        '.md'
      );
    }

// 3. Export as Microsoft Word Document (.doc)
async function exportCardsAsDoc(cardsArray) {
      if (!cardsArray || cardsArray.length === 0) {
        alert("No flashcards found to export.");
        return;
      }
      let bodyHtml = `<h2>Philippine Bar Recitation Deck</h2><p><em>Exported: ${new Date().toLocaleDateString()}</em></p><hr/>`;
      cardsArray.forEach((card, index) => {
        const qNum = index + 1;
        const header = typeof formatExportQuestionHeader === 'function' 
          ? formatExportQuestionHeader(card, qNum) 
          : `Question ${qNum}: ${card.topic || card.title || 'Bar Review Topic'}`;
        const question = card.question_text || card.question || card.front || '';
        let answersHtml = '';

        if (typeof extractCardParagraphsForExport === 'function') {
          const paras = extractCardParagraphsForExport(card);
          answersHtml = paras.map(p => `<p style="margin-top: 6px; margin-bottom: 6px; text-align: justify;">${escapeHtml(p)}</p>`).join('');
        } else {
          const ans = card.answer || card.back || '';
          answersHtml = `<p style="margin-top: 6px; margin-bottom: 6px;">${escapeHtml(ans)}</p>`;
        }

        bodyHtml += `
          <div style="margin-bottom: 20px; padding: 12px; border: 1px solid #ccc; background-color: #f9f9f9;">
            <h3 style="color: #1e3a8a; margin-top: 0; margin-bottom: 8px;">${escapeHtml(header)}</h3>
            ${question ? `<p style="font-weight: bold; margin-bottom: 8px;">${escapeHtml(question)}</p>` : ''}
            ${answersHtml}
            ${card.citation ? `<p style="font-size: 10pt; color: #555; margin-top: 6px;"><strong>Citation:</strong> ${escapeHtml(card.citation)}</p>` : ''}
          </div>
        `;
      });

      const docWrapper = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office' 
              xmlns:w='urn:schemas-microsoft-com:office:word' 
              xmlns='http://www.w3.org/TR/REC-html40'>
        <head><meta charset='utf-8'><title>Bar Recitation Deck</title></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.5;">
          ${bodyHtml}
        </body>
        </html>
      `;

      await exportWithSaveDialog(
        docWrapper,
        'Bar_Recitation_Reviewer.doc',
        'application/msword',
        'Microsoft Word Document',
        '.doc'
      );
    }

    // =========================================================================
    // PHASE 1: CORE CARD LIFECYCLE, SUSPENSION, BURY & DECK UTILITIES
    // =========================================================================
    function isCardBuriedToday(card) {
      if (!card || !card.buriedUntil) return false;
      return new Date(card.buriedUntil).getTime() > Date.now();
    }

    async function toggleCardSuspension(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) return;

      const card = deck.cards[cardIndex];
      card.isSuspended = !card.isSuspended;

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (typeof renderBrowserCardsList === 'function' && currentBrowsingDeckId === deckId) {
        renderBrowserCardsList();
      }
    }

    async function toggleCardBuryToday(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) return;

      const card = deck.cards[cardIndex];
      if (isCardBuriedToday(card)) {
        delete card.buriedUntil;
      } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(4, 0, 0, 0);
        card.buriedUntil = tomorrow.toISOString();
      }

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (typeof renderBrowserCardsList === 'function' && currentBrowsingDeckId === deckId) {
        renderBrowserCardsList();
      }
    }

    async function deleteCardFromDeck(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) return;

      const topicLabel = deck.cards[cardIndex].topic || `Card ${cardIndex + 1}`;
      if (!confirm(`Delete card "${topicLabel}" from "${deck.title}"?`)) return;

      deck.cards.splice(cardIndex, 1);

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (typeof renderBrowserCardsList === 'function' && currentBrowsingDeckId === deckId) {
        renderBrowserCardsList();
      }
    }

    async function duplicateCardInDeck(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) return;

      const source = deck.cards[cardIndex];
      const cloned = JSON.parse(JSON.stringify(source));
      cloned.id = 'card_copy_' + Date.now();
      cloned.topic = `${source.topic || 'Card'} (Copy)`;
      delete cloned.isSuspended;
      delete cloned.buriedUntil;

      deck.cards.splice(cardIndex + 1, 0, cloned);

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (typeof renderBrowserCardsList === 'function' && currentBrowsingDeckId === deckId) {
        renderBrowserCardsList();
      }
    }

    async function bulkUnsuspendDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards) return;

      deck.cards.forEach(c => { delete c.isSuspended; });

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (typeof renderBrowserCardsList === 'function' && currentBrowsingDeckId === deckId) {
        renderBrowserCardsList();
      }
    }

    async function bulkUnburyDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards) return;

      deck.cards.forEach(c => { delete c.buriedUntil; });

      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (typeof renderBrowserCardsList === 'function' && currentBrowsingDeckId === deckId) {
        renderBrowserCardsList();
      }
    }

    async function duplicateSavedDeck(deckId) {
      const deck = await dbGet('decks', deckId);
      if (!deck) return;

      const defaultName = `${deck.title} (Copy)`;
      const title = prompt("Enter a title for the duplicated deck:", defaultName);
      if (!title || !title.trim()) return;

      const newDeck = {
        id: 'deck_' + Date.now(),
        subject: deck.subject || currentSubjectName,
        title: title.trim(),
        createdAt: new Date().toISOString(),
        cards: JSON.parse(JSON.stringify(deck.cards || []))
      };

      await dbSave('decks', newDeck);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      alert(`Success! Created independent copy: "${newDeck.title}" (${newDeck.cards.length} cards).`);
    }

    async function promptMergeDecks(preSelectedDeckId) {
      activeMergeSourceDecks = await dbGetAll('decks');
      if (activeMergeSourceDecks.length < 2) {
        alert("You need at least two saved decks in this subject workspace to perform a merge.");
        return;
      }

      const selA = document.getElementById('mergeDeckASelect');
      const selB = document.getElementById('mergeDeckBSelect');
      if (!selA || !selB) return;

      selA.innerHTML = '';
      selB.innerHTML = '';

      activeMergeSourceDecks.forEach((d) => {
        const count = d.cards ? d.cards.length : 0;
        const optA = document.createElement('option');
        optA.value = d.id;
        optA.innerText = `${d.title} (${count} cards)`;
        selA.appendChild(optA);

        const optB = document.createElement('option');
        optB.value = d.id;
        optB.innerText = `${d.title} (${count} cards)`;
        selB.appendChild(optB);
      });

      if (preSelectedDeckId) {
        selA.value = preSelectedDeckId;
        const other = activeMergeSourceDecks.find(d => d.id !== preSelectedDeckId);
        if (other) selB.value = other.id;
      } else {
        selA.selectedIndex = 0;
        selB.selectedIndex = 1;
      }

      document.getElementById('deckMergeModal').classList.remove('hidden');
      onMergeDeckSelectionChanged();
    }

    let editingMergeCardContext = null;

    function closeMergeModal() {
      document.getElementById('deckMergeModal').classList.add('hidden');
      editingMergeCardContext = null;
    }

    async function openStudioToEditMergeCard(originDeckId, cardIdxInOrigin) {
      const deck = await dbGet('decks', originDeckId);
      if (!deck || !deck.cards || !deck.cards[cardIdxInOrigin]) {
        alert("Card could not be loaded from source deck.");
        return;
      }

      const card = deck.cards[cardIdxInOrigin];
      editingMergeCardContext = { originDeckId, cardIdxInOrigin, cardRef: card };

      // Temporarily hide the Deck Merge modal while editing
      const mergeModal = document.getElementById('deckMergeModal');
      if (mergeModal) mergeModal.classList.add('hidden');

      // Open the Card Studio modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Pre-fill Title, Citation, and Prompt
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || card.question || '';

      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Populate Dynamic Sub-fields
      if (card.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = card.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (card.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = card.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = card.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Configure Modal Actions
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Merge Card";

      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    async function applyMergeCardUpdate() {
      if (!editingMergeCardContext) return;
      const { originDeckId, cardIdxInOrigin } = editingMergeCardContext;

      const deck = await dbGet('decks', originDeckId);
      if (!deck || !deck.cards || !deck.cards[cardIdxInOrigin]) return;

      const targetCard = deck.cards[cardIdxInOrigin];
      const topic = document.getElementById('customTopicInput')?.value.trim() || targetCard.topic || '';
      const citation = document.getElementById('customCitationInput')?.value.trim() || '';
      const question = document.getElementById('customQuestionPromptInput')?.value.trim() || '';

      targetCard.topic = topic;
      if (targetCard.case_title) targetCard.case_title = topic;
      targetCard.citation = citation;
      targetCard.rule_citation = citation;
      targetCard.question_text = question;

      const archetype = currentCardArchetype || 'CODAL';

      if (archetype === 'CASE') {
        targetCard.benchmark_fir = {
          facts: document.getElementById('caseFactsInput')?.value.trim() || '',
          issue: document.getElementById('caseIssueInput')?.value.trim() || '',
          ruling: document.getElementById('caseRulingInput')?.value.trim() || '',
          ratio_doctrine: document.getElementById('caseRatioInput')?.value.trim() || ''
        };
      } else if (archetype === 'CODAL') {
        targetCard.benchmark_codal_breakdown = {
          operative_rule_summary: document.getElementById('codalRuleInput')?.value.trim() || '',
          elements_requisites: document.getElementById('codalRequisitesInput')?.value.trim() || '',
          statutory_exceptions: document.getElementById('codalStatExceptionsInput')?.value.trim() || '',
          jurisprudential_exceptions: document.getElementById('codalJurisExceptionsInput')?.value.trim() || '',
          application_ratio: targetCard.benchmark_codal_breakdown?.application_ratio || ''
        };
        targetCard.codal_provision_text = targetCard.benchmark_codal_breakdown.operative_rule_summary;
      } else if (archetype === 'ALAC') {
        targetCard.benchmark_alac = {
          p1_direct_answer: document.getElementById('alacAInput')?.value.trim() || '',
          p2_legal_basis: document.getElementById('alacLInput')?.value.trim() || '',
          p3_analysis: document.getElementById('alacAppInput')?.value.trim() || '',
          p4_conclusion: document.getElementById('alacCInput')?.value.trim() || ''
        };
      } else {
        const simple = document.getElementById('simpleAnswerInput')?.value.trim() || '';
        targetCard.answer = simple;
        targetCard.model_answer = simple;
      }

      // Persist changes to source deck in IndexedDB
      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();

      // Refresh memory list of merge decks
      activeMergeSourceDecks = await dbGetAll('decks');

      // Close Card Studio
      document.getElementById('cardCreatorModal')?.classList.add('hidden');
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Save Card";
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.remove('hidden');

      // Re-open and refresh Merge Preview modal
      editingMergeCardContext = null;
      const mergeModal = document.getElementById('deckMergeModal');
      if (mergeModal) {
        mergeModal.classList.remove('hidden');
        if (typeof onMergeDeckSelectionChanged === 'function') onMergeDeckSelectionChanged();
      }
    }

    function onMergeDeckSelectionChanged() {
      const idA = document.getElementById('mergeDeckASelect').value;
      const idB = document.getElementById('mergeDeckBSelect').value;
      const container = document.getElementById('mergeCardsListContainer');
      const summaryBadge = document.getElementById('mergeSummaryBadge');
      const titleInput = document.getElementById('mergeNewDeckTitleInput');
      const isDedup = document.getElementById('mergeDedupToggle').checked;

      const deckA = activeMergeSourceDecks.find(d => d.id === idA);
      const deckB = activeMergeSourceDecks.find(d => d.id === idB);

      if (!deckA || !deckB) return;

      if (idA === idB) {
        container.innerHTML = `<div class="text-amber-400 italic text-center py-8">Please choose two different decks to merge.</div>`;
        summaryBadge.innerText = "Select two distinct decks";
        return;
      }

      titleInput.value = `${deckA.title} + ${deckB.title} (Merged)`;

      const cardsA = Array.isArray(deckA.cards) ? deckA.cards : [];
      const cardsB = Array.isArray(deckB.cards) ? deckB.cards : [];

      let mergedList = [];
      const seen = new Set();

      cardsA.forEach((c) => {
        const sig = (c.question_text || c.topic || c.case_title || '').trim().toLowerCase();
        seen.add(sig);
        mergedList.push({ card: c, sourceLabel: deckA.title, sourceColor: 'text-amber-300 border-amber-800 bg-amber-950/40', originId: deckA.id });
      });

      cardsB.forEach((c) => {
        const sig = (c.question_text || c.topic || c.case_title || '').trim().toLowerCase();
        if (isDedup && seen.has(sig)) return;
        seen.add(sig);
        mergedList.push({ card: c, sourceLabel: deckB.title, sourceColor: 'text-sky-300 border-sky-800 bg-sky-950/40', originId: deckB.id });
      });

      summaryBadge.innerText = `${mergedList.length} Cards Total (${cardsA.length} from Deck 1, ${cardsB.length} from Deck 2)`;

      container.innerHTML = mergedList.map((entry, idx) => {
        const c = entry.card;
        const topic = c.topic || c.case_title || 'Untitled Card';
        const promptText = c.question_text || c.question || 'No question prompt text available';
        const dimTag = c.exportTag || (c.dimensionId ? `Dim ${c.dimensionId}` : '');

        return `
          <div class="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-1 hover:border-slate-700 transition">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-slate-100 truncate">${idx + 1}. ${escapeHtml(topic)}</span>
              <div class="flex items-center space-x-2 shrink-0">
                ${dimTag ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">${escapeHtml(dimTag)}</span>` : ''}
                <span class="px-2 py-0.5 rounded text-[10px] font-mono border ${entry.sourceColor}">${escapeHtml(entry.sourceLabel)}</span>
              </div>
            </div>
            <p class="text-slate-400 text-[11px] line-clamp-2 leading-relaxed">${escapeHtml(promptText)}</p>
          </div>
        `;
      }).join('');
    }

    async function executeDeckMerge() {
      const idA = document.getElementById('mergeDeckASelect').value;
      const idB = document.getElementById('mergeDeckBSelect').value;
      const newTitle = document.getElementById('mergeNewDeckTitleInput').value.trim();
      const isDedup = document.getElementById('mergeDedupToggle').checked;

      if (idA === idB) {
        alert("Select two different decks to merge.");
        return;
      }
      if (!newTitle) {
        alert("Please enter a title for the new merged deck.");
        return;
      }

      const deckA = activeMergeSourceDecks.find(d => d.id === idA);
      const deckB = activeMergeSourceDecks.find(d => d.id === idB);
      if (!deckA || !deckB) return;

      const combined = [];
      const seen = new Set();

      const addCard = (card, originId, originTitle) => {
        const sig = (card.question_text || card.topic || card.case_title || '').trim().toLowerCase();
        if (isDedup && seen.has(sig)) return;
        seen.add(sig);

        combined.push({
          ...JSON.parse(JSON.stringify(card)),
          id: 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          originDeckId: originId,
          originDeckTitle: originTitle
        });
      };

      (deckA.cards || []).forEach(c => addCard(c, deckA.id, deckA.title));
      (deckB.cards || []).forEach(c => addCard(c, deckB.id, deckB.title));

      const mergedDeckObj = {
        id: 'deck_merged_' + Date.now(),
        subject: currentSubjectName,
        title: newTitle,
        createdAt: new Date().toISOString(),
        cards: combined,
        isMerged: true
      };

      await dbSave('decks', mergedDeckObj);
      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      closeMergeModal();

      alert(`✅ Created merged deck: "${mergedDeckObj.title}" with ${mergedDeckObj.cards.length} cards.`);
    }

    // =========================================================================
    // PHASE 2: DECK CARD BROWSER & INSPECTOR CONTROLLER
    // =========================================================================
    let currentBrowsingDeckId = null;
    let browserStateFilter = 'ALL';

    async function openDeckBrowserModal(deckId) {
      currentBrowsingDeckId = deckId;
      browserStateFilter = 'ALL';
      const searchInput = document.getElementById('browserSearchInput');
      if (searchInput) searchInput.value = '';

      setBrowserStateFilter('ALL', true);
      document.getElementById('deckBrowserModal')?.classList.remove('hidden');
      await renderBrowserCardsList();
    }

    function closeDeckBrowserModal() {
      currentBrowsingDeckId = null;
      document.getElementById('deckBrowserModal')?.classList.add('hidden');
    }

    function setBrowserStateFilter(filterKey, skipRender = false) {
      browserStateFilter = filterKey;
      ['ALL', 'ACTIVE', 'SUSPENDED', 'BURIED', 'DEFICIENT'].forEach(k => {
        const btn = document.getElementById('filterBtn_' + k);
        if (!btn) return;
        if (k === filterKey) {
          btn.className = "px-2.5 py-1 rounded bg-amber-600 text-slate-950 font-bold transition";
        } else {
          btn.className = "px-2.5 py-1 rounded text-slate-400 hover:text-slate-200 transition";
        }
      });
      if (!skipRender) {
        filterBrowserCardRows();
      }
    }

    async function renderBrowserCardsList() {
      if (!currentBrowsingDeckId) return;
      const deck = await dbGet('decks', currentBrowsingDeckId);
      const container = document.getElementById('browserCardsContainer');
      const titleEl = document.getElementById('browserDeckTitle');
      const countBadge = document.getElementById('browserDeckCountBadge');
      if (!container || !deck) return;

      if (titleEl) titleEl.innerText = deck.title;
      const cards = deck.cards || [];
      if (countBadge) countBadge.innerText = `${cards.length} Cards`;

      const masteryRecords = await dbGetAll('mastery');
      const deficientKeys = new Set(
        masteryRecords
          .filter(m => m.status === 'CRITICAL_DRILL' || m.score < 0)
          .map(m => (m.topic || '').trim().toLowerCase())
      );

      let countActive = 0, countSuspended = 0, countBuried = 0, countDeficient = 0;
      cards.forEach(c => {
        const isSusp = Boolean(c.isSuspended);
        const isBur = isCardBuriedToday(c);
        const cardTopicKey = (c.topic || c.case_title || '').trim().toLowerCase();
        const isDef = deficientKeys.has(cardTopicKey);

        if (isSusp) countSuspended++;
        else if (isBur) countBuried++;
        else countActive++;

        if (isDef) countDeficient++;
      });

      document.getElementById('count_ALL').innerText = cards.length;
      document.getElementById('count_ACTIVE').innerText = countActive;
      document.getElementById('count_SUSPENDED').innerText = countSuspended;
      document.getElementById('count_BURIED').innerText = countBuried;
      document.getElementById('count_DEFICIENT').innerText = countDeficient;

      container.innerHTML = '';
      if (cards.length === 0) {
        container.innerHTML = `<div class="text-center py-10 text-slate-400 italic">This deck has no cards.</div>`;
        const summary = document.getElementById('browserFooterSummary');
        if (summary) summary.innerText = "Showing 0 cards";
        return;
      }

      cards.forEach((card, idx) => {
        const isSusp = Boolean(card.isSuspended);
        const isBur = isCardBuriedToday(card);
        const cardTopicKey = (card.topic || card.case_title || '').trim().toLowerCase();
        const isDef = deficientKeys.has(cardTopicKey);

        let stateBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">● Active</span>`;
        if (isSusp) stateBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-950 text-red-300 border border-red-800" title="Excluded from recitation drills">🚫 Suspended</span>`;
        else if (isBur) stateBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950 text-amber-300 border border-amber-800" title="Hidden until tomorrow 4:00 AM">⏸ Buried</span>`;
        if (isDef) stateBadge += ` <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950 text-rose-300 border border-rose-800" title="Flagged in Weak-Spot Ledger">⚠️ Deficient</span>`;

        const rowDiv = document.createElement('div');
        rowDiv.className = "card-row bg-slate-950 border border-slate-800 rounded-xl p-3.5 transition hover:border-slate-700 space-y-2";
        rowDiv.dataset.index = idx;
        rowDiv.dataset.state = isSusp ? 'SUSPENDED' : (isBur ? 'BURIED' : 'ACTIVE');
        rowDiv.dataset.isDeficient = isDef ? 'true' : 'false';
        rowDiv.dataset.text = `${card.topic || ''} ${card.rule_citation || ''} ${card.question_text || ''}`.toLowerCase();

        const benchmarkParagraphs = extractCardParagraphsForExport(card);
        const benchmarkContentHtml = benchmarkParagraphs.length > 0
          ? formatBenchmarkText(benchmarkParagraphs.join('\n\n'))
          : '<span class="text-slate-500 italic">No structured benchmark attached.</span>';

        rowDiv.innerHTML = `
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1 cursor-pointer" onclick="toggleCardDetailAccordion(${idx})">
              <div class="flex items-center space-x-2 flex-wrap gap-y-1">
                <span class="font-mono text-amber-400 font-bold text-xs">#${idx + 1}</span>
                <span class="font-bold text-slate-100 text-xs truncate max-w-lg hover:text-amber-300 transition">${escapeHtml(card.topic || card.case_title || 'Untitled Card')}</span>
                <span class="text-[10px] font-mono text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">${escapeHtml(card.exportTag || card.dimension || 'Card')}</span>
                ${stateBadge}
              </div>
              <p class="text-[11px] text-slate-400 mt-1 line-clamp-2 font-sans">${escapeHtml(card.question_text || 'No prompt set.')}</p>
            </div>

            <div class="flex items-center space-x-1.5 shrink-0">
            <!-- EDIT CARD IN PLACE -->
            <button type="button" onclick="openStudioToEditBrowserCard('${currentBrowsingDeckId}', ${idx})" class="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/60 rounded text-[10px] font-mono transition font-semibold" title="Edit this card in place">
              ✏️ Edit
            </button>
            <!-- EDIT CARD IN PLACE -->
            <button type="button" onclick="openStudioToEditBrowserCard('${currentBrowsingDeckId}', ${idx})" class="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/60 rounded text-[10px] font-mono transition font-semibold" title="Edit this card in place">
              ✏️ Edit
            </button>
              <button onclick="editCardFromBrowser('${deck.id}', ${idx})" class="p-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded font-mono text-[11px] transition" title="Edit this card's question, elements, or model answers">
                ✏️
              </button>
              <button onclick="duplicateCardInDeck('${deck.id}', ${idx})" class="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono text-[11px] transition" title="Clones this card's facts and citations into an independent duplicate">
                ⎘
              </button>
              <button onclick="toggleCardSuspension('${deck.id}', ${idx})" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 ${isSusp ? 'text-emerald-400' : 'text-red-400'} rounded font-mono text-[10px] transition font-bold" title="${isSusp ? 'Restores this card back into your active recitation queue' : 'Temporarily removes this card from all recitation queues without deleting it from your deck or exports'}">
                ${isSusp ? '✓ Unsuspend' : '🚫 Suspend'}
              </button>
              <button onclick="toggleCardBuryToday('${deck.id}', ${idx})" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 ${isBur ? 'text-amber-300' : 'text-slate-400'} rounded font-mono text-[10px] transition font-bold" title="${isBur ? 'Immediately wakes this buried card and places it back into today\'s drills' : 'Hides this card from today\'s drills; it will automatically reappear tomorrow at 4:00 AM'}">
                ${isBur ? '▶ Unbury' : '⏸ Bury'}
              </button>
              <button onclick="deleteCardFromDeck('${deck.id}', ${idx})" class="p-1.5 bg-slate-800 hover:bg-red-950 text-red-400 rounded font-mono text-[11px] transition" title="Permanently delete this card from the deck">
                ✕
              </button>
            </div>
          </div>

          <div id="cardDetail_${idx}" class="hidden pt-2 border-t border-slate-900 text-xs text-slate-300 space-y-2 bg-slate-900/50 p-3 rounded-lg">
            <div class="space-y-1">
              <b class="text-[10px] font-mono uppercase text-amber-400 block tracking-wider">Authoritative Benchmark:</b>
              <div class="text-slate-200 leading-relaxed">${benchmarkContentHtml}</div>
            </div>
            ${card.rule_citation ? `<span class="block text-[10px] font-mono text-slate-500 pt-1 border-t border-slate-800/80">Citation: ${escapeHtml(card.rule_citation)}</span>` : ''}
          </div>
        `;
        container.appendChild(rowDiv);
      });

      filterBrowserCardRows();
    }

    function toggleCardDetailAccordion(idx) {
      const el = document.getElementById(`cardDetail_${idx}`);
      if (el) el.classList.toggle('hidden');
    }

    function filterBrowserCardRows() {
      const query = (document.getElementById('browserSearchInput')?.value || '').toLowerCase().trim();
      const rows = document.querySelectorAll('.card-row');
      let visibleCount = 0;

      rows.forEach(r => {
        const matchesQuery = !query || r.dataset.text.includes(query);
        let matchesFilter = true;

        if (browserStateFilter === 'ACTIVE') matchesFilter = (r.dataset.state === 'ACTIVE');
        else if (browserStateFilter === 'SUSPENDED') matchesFilter = (r.dataset.state === 'SUSPENDED');
        else if (browserStateFilter === 'BURIED') matchesFilter = (r.dataset.state === 'BURIED');
        else if (browserStateFilter === 'DEFICIENT') matchesFilter = (r.dataset.isDeficient === 'true');

        if (matchesQuery && matchesFilter) {
          r.classList.remove('hidden');
          visibleCount++;
        } else {
          r.classList.add('hidden');
        }
      });

      const summary = document.getElementById('browserFooterSummary');
      if (summary) summary.innerText = `Showing ${visibleCount} cards`;
    }

    async function bulkUnsuspendCurrentDeck() {
      if (!currentBrowsingDeckId) return;
      await bulkUnsuspendDeck(currentBrowsingDeckId);
    }

    async function bulkUnburyCurrentDeck() {
      if (!currentBrowsingDeckId) return;
      await bulkUnburyDeck(currentBrowsingDeckId);
    }

    // =========================================================================
    // PHASE 3 & PHASE 5: CUSTOM CARD STUDIO, BULK INGESTION & IN-PLACE CONTROLLER
    // =========================================================================
    let currentCardStudioMode = 'SINGLE';
    let currentCardArchetype = 'CODAL';
    let editingCardContext = null;

    async function openStudioToEditBrowserCard(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) {
        alert("Card could not be loaded from deck.");
        return;
      }

      const card = deck.cards[cardIndex];
      editingBrowserCardContext = { deckId, cardIndex, cardRef: card };

      // Temporarily hide the Deck Browser modal while editing
      const browserModal = document.getElementById('deckBrowserModal');
      if (browserModal) browserModal.classList.add('hidden');

      // Open the Card Studio modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Pre-fill Title, Citation, and Prompt
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || card.question || '';

      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Detect Archetype and Populate Fields
      if (card.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = card.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (card.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = card.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = card.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Configure Modal Actions
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Deck Card";

      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    let editingBrowserCardContext = null;

    async function openStudioToEditBrowserCard(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) {
        alert("Card could not be loaded from deck.");
        return;
      }

      const card = deck.cards[cardIndex];
      editingBrowserCardContext = { deckId, cardIndex, cardRef: card };

      // Temporarily hide the Deck Browser modal while editing
      const browserModal = document.getElementById('deckBrowserModal');
      if (browserModal) browserModal.classList.add('hidden');

      // Open the Card Studio modal
      if (typeof openCardCreatorModal === 'function') {
        openCardCreatorModal();
      } else {
        document.getElementById('cardCreatorModal')?.classList.remove('hidden');
      }

      // Pre-fill Title, Citation, and Prompt
      const topicInput = document.getElementById('customTopicInput');
      const citationInput = document.getElementById('customCitationInput');
      const questionInput = document.getElementById('customQuestionPromptInput');

      if (topicInput) topicInput.value = card.topic || card.case_title || '';
      if (citationInput) citationInput.value = card.citation || card.rule_citation || '';
      if (questionInput) questionInput.value = card.question_text || card.question || '';

      const dimId = card.dimensionId || card.forcedDimensionId || 1;

      // Detect Archetype and Populate Fields
      if (card.benchmark_fir || [5, 6, 7, 8].includes(dimId) || card.isCase) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CASE');
        const fir = card.benchmark_fir || {};
        const fInput = document.getElementById('caseFactsInput');
        const iInput = document.getElementById('caseIssueInput');
        const rInput = document.getElementById('caseRulingInput');
        const ratioInput = document.getElementById('caseRatioInput');

        if (fInput) fInput.value = fir.facts || '';
        if (iInput) iInput.value = fir.issue || '';
        if (rInput) rInput.value = fir.ruling || '';
        if (ratioInput) ratioInput.value = fir.ratio_doctrine || fir.doctrine || '';
      } else if (card.benchmark_codal_breakdown || [1, 2, 3].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('CODAL');
        const b = card.benchmark_codal_breakdown || {};
        const ruleInput = document.getElementById('codalRuleInput');
        const reqInput = document.getElementById('codalRequisitesInput');
        const statInput = document.getElementById('codalStatExceptionsInput');
        const jurisInput = document.getElementById('codalJurisExceptionsInput');

        if (ruleInput) ruleInput.value = card.codal_provision_text || b.operative_rule_summary || '';
        if (reqInput) reqInput.value = b.elements_requisites || '';
        if (statInput) statInput.value = b.statutory_exceptions || '';
        if (jurisInput) jurisInput.value = b.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac || [4, 9, 10].includes(dimId)) {
        if (typeof setCardArchetype === 'function') setCardArchetype('ALAC');
        const alac = card.benchmark_alac || {};
        const aInput = document.getElementById('alacAInput');
        const lInput = document.getElementById('alacLInput');
        const appInput = document.getElementById('alacAppInput');
        const cInput = document.getElementById('alacCInput');

        if (aInput) aInput.value = alac.p1_direct_answer || '';
        if (lInput) lInput.value = alac.p2_legal_basis || '';
        if (appInput) appInput.value = alac.p3_analysis || '';
        if (cInput) cInput.value = alac.p4_conclusion || '';
      } else {
        if (typeof setCardArchetype === 'function') setCardArchetype('SIMPLE');
        const simpleInput = document.getElementById('simpleAnswerInput');
        if (simpleInput) simpleInput.value = card.answer || card.model_answer || '';
      }

      // Configure Modal Actions
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Update Deck Card";

      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.add('hidden');
    }

    function openStudioForSpecificDeck(deckId) {
      openCardCreatorModal(deckId);
    }

    async function populateCardStudioDeckSelector(targetDeckId = '__NEW__') {
      const select = document.getElementById('cardDestinationDeckSelect');
      const newTitleInput = document.getElementById('newDeckTitleInput');
      const subBadge = document.getElementById('cardStudioSubjectBadge');
      if (subBadge) subBadge.innerText = `Subject: ${currentSubjectName}`;
      if (!select) return;

      const decks = await dbGetAll('decks');
      select.innerHTML = '<option value="__NEW__">+ Create New Deck...</option>';

      decks.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.innerText = `${d.title} (${d.cards ? d.cards.length : 0} cards)`;
        if (d.id === targetDeckId) opt.selected = true;
        select.appendChild(opt);
      });

      if (targetDeckId && targetDeckId !== '__NEW__') {
        select.value = targetDeckId;
        newTitleInput?.classList.add('hidden');
      } else {
        select.value = '__NEW__';
        if (newTitleInput) {
          newTitleInput.classList.remove('hidden');
          newTitleInput.value = `${currentSubjectName} - Custom Cards (${new Date().toLocaleDateString()})`;
        }
      }
    }

    function onDestinationDeckSelectChanged(val) {
      const newTitleInput = document.getElementById('newDeckTitleInput');
      if (val === '__NEW__') newTitleInput?.classList.remove('hidden');
      else newTitleInput?.classList.add('hidden');
    }

    function setCardStudioMode(mode) {
      currentCardStudioMode = mode;
      const singleBtn = document.getElementById('studioModeSingleBtn');
      const bulkBtn = document.getElementById('studioModeBulkBtn');
      const singlePanel = document.getElementById('singleCardStudioPanel');
      const bulkPanel = document.getElementById('bulkCardStudioPanel');
      const saveAndAddBtn = document.getElementById('saveAndAddAnotherBtn');
      const saveBtn = document.getElementById('saveAndCloseCardBtn');

      if (mode === 'SINGLE') {
        if (singleBtn) singleBtn.className = "px-3 py-1 rounded text-xs font-mono font-bold transition bg-amber-600 text-slate-950";
        if (bulkBtn) bulkBtn.className = "px-3 py-1 rounded text-xs font-mono text-slate-400 hover:text-slate-200 transition";
        singlePanel?.classList.remove('hidden');
        bulkPanel?.classList.add('hidden');
        saveAndAddBtn?.classList.remove('hidden');
        if (saveBtn) saveBtn.innerText = editingCardContext ? "Update Card" : "Save Card";
      } else {
        if (bulkBtn) bulkBtn.className = "px-3 py-1 rounded text-xs font-mono font-bold transition bg-sky-600 text-slate-950";
        if (singleBtn) singleBtn.className = "px-3 py-1 rounded text-xs font-mono text-slate-400 hover:text-slate-200 transition";
        bulkPanel?.classList.remove('hidden');
        singlePanel?.classList.add('hidden');
        saveAndAddBtn?.classList.add('hidden');
        if (saveBtn) saveBtn.innerText = "Import All Rows";
        previewBulkImportCount();
      }
    }

    function setCardArchetype(arch) {
  currentCardArchetype = arch;
  window._activeStudioArchetype = arch;
  const archetypes = ['CODAL', 'CASE', 'ALAC', 'PROCEDURAL', 'SIMPLE'];

      archetypes.forEach(a => {
        const btn = document.getElementById('archBtn_' + a);
        if (!btn) return;
        if (a === arch) {
          btn.className = "p-2 rounded-lg border border-amber-600 bg-amber-950/40 text-amber-300 font-mono font-bold text-left transition shadow";
        } else {
          btn.className = "p-2 rounded-lg border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200 font-mono font-bold text-left transition";
        }
      });

      document.getElementById('archetypeCodalFields')?.classList.add('hidden');
      document.getElementById('archetypeCaseFields')?.classList.add('hidden');
      document.getElementById('archetypeAlacFields')?.classList.add('hidden');
      document.getElementById('archetypeSimpleFields')?.classList.add('hidden');

      const topicLabel = document.getElementById('customTopicLabel');

      if (arch === 'CODAL') {
        document.getElementById('archetypeCodalFields')?.classList.remove('hidden');
        if (topicLabel) topicLabel.innerText = "Topic / Provision *";
      } else if (arch === 'CASE') {
        document.getElementById('archetypeCaseFields')?.classList.remove('hidden');
        if (topicLabel) topicLabel.innerText = "Case Title *";
      } else if (arch === 'ALAC' || arch === 'PROCEDURAL') {
        document.getElementById('archetypeAlacFields')?.classList.remove('hidden');
        if (topicLabel) topicLabel.innerText = arch === 'PROCEDURAL' ? "Procedural Vehicle / Remedy *" : "Topic / Problem Concept *";
      } else {
        document.getElementById('archetypeSimpleFields')?.classList.remove('hidden');
        if (topicLabel) topicLabel.innerText = "Card Heading / Concept *";
      }
    }

    async function openCardCreatorModal(preselectedDeckId = '__NEW__') {
      editingCardContext = null;
      document.getElementById('cardCreatorModalTitle').innerText = "Custom Flashcard Studio";
      document.getElementById('saveAndCloseCardBtn').innerText = "Save Card";
      document.getElementById('saveAndAddAnotherBtn')?.classList.remove('hidden');
      document.getElementById('cardDestinationDeckSelect')?.removeAttribute('disabled');

      document.getElementById('customTopicInput').value = '';
      document.getElementById('customCitationInput').value = '';
      document.getElementById('customQuestionPromptInput').value = '';
      document.getElementById('codalRuleInput').value = '';
      document.getElementById('codalRequisitesInput').value = '';
      document.getElementById('codalStatExceptionsInput').value = '';
      document.getElementById('codalJurisExceptionsInput').value = '';
      document.getElementById('caseFactsInput').value = '';
      document.getElementById('caseIssueInput').value = '';
      document.getElementById('caseRulingInput').value = '';
      document.getElementById('caseRatioInput').value = '';
      document.getElementById('alacAInput').value = '';
      document.getElementById('alacLInput').value = '';
      document.getElementById('alacAppInput').value = '';
      document.getElementById('alacCInput').value = '';
      document.getElementById('simpleAnswerInput').value = '';
      document.getElementById('bulkImportRawText').value = '';
      document.getElementById('cardStudioFooterStatus').innerText = "Ready to author";

      setCardStudioMode('SINGLE');
      setCardArchetype('CODAL');
      await populateCardStudioDeckSelector(preselectedDeckId);
      document.getElementById('cardCreatorModal')?.classList.remove('hidden');
    }

function closeCardCreatorModal() {
  editingCardContext = null;
  document.getElementById('cardCreatorModal')?.classList.add('hidden');
  document.getElementById('clozeFloatingToolbar')?.classList.add('hidden');

  // Reset button states
  const saveBtn = document.getElementById('saveAndCloseCardBtn');
  if (saveBtn) saveBtn.innerText = "Save Card";
  const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
  if (addAnotherBtn) addAnotherBtn.classList.remove('hidden');

  // Re-open evaluation modal if edit was triggered from there
  if (isEditingFromEvaluation) {
    isEditingFromEvaluation = false;
    const evalModal = document.getElementById('evalModal');
    if (evalModal) evalModal.classList.remove('hidden');
  }
}

async function applyInPlaceCardUpdate() {
  const card = state.activeCardItem;
  if (!card) return;

  const topic = document.getElementById('customTopicInput')?.value.trim() || card.topic || card.case_title || '';
  const citation = document.getElementById('customCitationInput')?.value.trim() || '';
  const question = document.getElementById('customQuestionPromptInput')?.value.trim() || state.currentQuestionText || '';

  // Update core fields
  card.topic = topic;
  if (card.case_title) card.case_title = topic;
  card.citation = citation;
  card.rule_citation = citation;
  card.question_text = question;
  state.currentQuestionText = question;

  // Use the active archetype from your existing variable
  const archetype = currentCardArchetype || 'CODAL';

  if (archetype === 'CASE') {
    const fir = {
      facts: document.getElementById('caseFactsInput')?.value.trim() || '',
      issue: document.getElementById('caseIssueInput')?.value.trim() || '',
      ruling: document.getElementById('caseRulingInput')?.value.trim() || '',
      ratio_doctrine: document.getElementById('caseRatioInput')?.value.trim() || ''
    };
    card.benchmark_fir = fir;
    if (state.currentBenchmarkPayload) state.currentBenchmarkPayload.benchmark_fir = fir;
  } else if (archetype === 'CODAL') {
    const codal = {
      operative_rule_summary: document.getElementById('codalRuleInput')?.value.trim() || '',
      elements_requisites: document.getElementById('codalRequisitesInput')?.value.trim() || '',
      statutory_exceptions: document.getElementById('codalStatExceptionsInput')?.value.trim() || '',
      jurisprudential_exceptions: document.getElementById('codalJurisExceptionsInput')?.value.trim() || '',
      application_ratio: card.benchmark_codal_breakdown?.application_ratio || ''
    };
    card.benchmark_codal_breakdown = codal;
    card.codal_provision_text = codal.operative_rule_summary;
    if (state.currentBenchmarkPayload) {
      state.currentBenchmarkPayload.benchmark_codal_breakdown = codal;
      state.currentBenchmarkPayload.codal_provision_text = codal.operative_rule_summary;
    }
  } else if (archetype === 'ALAC') {
    const alac = {
      p1_direct_answer: document.getElementById('alacAInput')?.value.trim() || '',
      p2_legal_basis: document.getElementById('alacLInput')?.value.trim() || '',
      p3_analysis: document.getElementById('alacAppInput')?.value.trim() || '',
      p4_conclusion: document.getElementById('alacCInput')?.value.trim() || ''
    };
    card.benchmark_alac = alac;
    if (state.currentBenchmarkPayload) state.currentBenchmarkPayload.benchmark_alac = alac;
  } else {
    const simple = document.getElementById('simpleAnswerInput')?.value.trim() || '';
    card.answer = simple;
    card.model_answer = simple;
  }

  // 1. Update in active memory pools
  const qIdx = state.currentQuestionIndex - 1;
  if (state.activeAgenda && state.activeAgenda[qIdx]) {
    state.activeAgenda[qIdx] = { ...state.activeAgenda[qIdx], ...card };
  }

  const poolIdx = state.activeDeckCardsPool.findIndex(c =>
    (c.topic === card.topic || c.case_title === card.case_title) && c.dimensionId === card.dimensionId
  );
  if (poolIdx !== -1) {
    state.activeDeckCardsPool[poolIdx] = { ...card };
  }

  // 2. If session belongs to a saved deck, mutate in IndexedDB
  if (state.activeDeckTitle) {
    const decks = await dbGetAll('decks');
    const activeDeck = decks.find(d => d.title === state.activeDeckTitle);
    if (activeDeck && Array.isArray(activeDeck.cards)) {
      const dCardIdx = activeDeck.cards.findIndex(c =>
        (c.topic === card.topic || c.case_title === card.case_title) && c.dimensionId === card.dimensionId
      );
      if (dCardIdx !== -1) {
        activeDeck.cards[dCardIdx] = { ...card };
        await dbSave('decks', activeDeck);
      }
    }
  }

  // 3. Update active card UI
  const qContainer = document.getElementById('questionContainer');
  if (qContainer) qContainer.innerText = question;

  const topicBadge = document.getElementById('activeTopicName');
  if (topicBadge) topicBadge.innerText = `${topic} (${citation || currentSubjectName})`;

  // 4. Trigger cloud sync and timestamps
  await stampSubjectModifiedTimestamp();

  // 5. Close editor
  document.getElementById('cardCreatorModal')?.classList.add('hidden');
  const saveBtn = document.getElementById('saveAndCloseCardBtn');
  if (saveBtn) saveBtn.innerText = "Save Card";
  const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
  if (addAnotherBtn) addAnotherBtn.classList.remove('hidden');

  // 6. If opened from evaluation, re-render evaluation benchmark with updated values and re-open modal
  if (isEditingFromEvaluation) {
    isEditingFromEvaluation = false;
    const lastTranscript = state.sessionTranscript[state.sessionTranscript.length - 1];
    if (lastTranscript) {
      renderEvaluation({
        rating: lastTranscript.rating || 'SATISFACTORY',
        critique: lastTranscript.critique || 'Card updated in place.',
        missed_details: 'Benchmark breakdown refreshed.',
        correction_polish: 'Ready for next recitation.'
      });
    }
  }
}
async function applyDeckBrowserCardUpdate() {
      if (!editingBrowserCardContext) return;
      const { deckId, cardIndex } = editingBrowserCardContext;

      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) return;

      const targetCard = deck.cards[cardIndex];
      const topic = document.getElementById('customTopicInput')?.value.trim() || targetCard.topic || '';
      const citation = document.getElementById('customCitationInput')?.value.trim() || '';
      const question = document.getElementById('customQuestionPromptInput')?.value.trim() || '';

      targetCard.topic = topic;
      if (targetCard.case_title) targetCard.case_title = topic;
      targetCard.citation = citation;
      targetCard.rule_citation = citation;
      targetCard.question_text = question;

      const archetype = currentCardArchetype || 'CODAL';

      if (archetype === 'CASE') {
        targetCard.benchmark_fir = {
          facts: document.getElementById('caseFactsInput')?.value.trim() || '',
          issue: document.getElementById('caseIssueInput')?.value.trim() || '',
          ruling: document.getElementById('caseRulingInput')?.value.trim() || '',
          ratio_doctrine: document.getElementById('caseRatioInput')?.value.trim() || ''
        };
      } else if (archetype === 'CODAL') {
        targetCard.benchmark_codal_breakdown = {
          operative_rule_summary: document.getElementById('codalRuleInput')?.value.trim() || '',
          elements_requisites: document.getElementById('codalRequisitesInput')?.value.trim() || '',
          statutory_exceptions: document.getElementById('codalStatExceptionsInput')?.value.trim() || '',
          jurisprudential_exceptions: document.getElementById('codalJurisExceptionsInput')?.value.trim() || '',
          application_ratio: targetCard.benchmark_codal_breakdown?.application_ratio || ''
        };
        targetCard.codal_provision_text = targetCard.benchmark_codal_breakdown.operative_rule_summary;
      } else if (archetype === 'ALAC') {
        targetCard.benchmark_alac = {
          p1_direct_answer: document.getElementById('alacAInput')?.value.trim() || '',
          p2_legal_basis: document.getElementById('alacLInput')?.value.trim() || '',
          p3_analysis: document.getElementById('alacAppInput')?.value.trim() || '',
          p4_conclusion: document.getElementById('alacCInput')?.value.trim() || ''
        };
      } else {
        const simple = document.getElementById('simpleAnswerInput')?.value.trim() || '';
        targetCard.answer = simple;
        targetCard.model_answer = simple;
      }

      // Persist to IndexedDB
      await dbSave('decks', deck);
      await stampSubjectModifiedTimestamp();

      // Close Card Studio
      document.getElementById('cardCreatorModal')?.classList.add('hidden');
      const saveBtn = document.getElementById('saveAndCloseCardBtn');
      if (saveBtn) saveBtn.innerText = "Save Card";
      const addAnotherBtn = document.getElementById('saveAndAddAnotherBtn');
      if (addAnotherBtn) addAnotherBtn.classList.remove('hidden');

      // Re-open and refresh Deck Browser modal
      editingBrowserCardContext = null;
      const browserModal = document.getElementById('deckBrowserModal');
      if (browserModal) {
        browserModal.classList.remove('hidden');
        if (typeof renderBrowserCardsList === 'function') renderBrowserCardsList();
      }
    }
    async function editCardFromBrowser(deckId, cardIndex) {
      const deck = await dbGet('decks', deckId);
      if (!deck || !deck.cards || !deck.cards[cardIndex]) return;
      const card = deck.cards[cardIndex];

      await openCardCreatorModal(deckId);
      editingCardContext = { deckId, cardIndex, cardRef: card };

      document.getElementById('cardCreatorModalTitle').innerText = `Edit Card #${cardIndex + 1}: ${card.topic || 'Card'}`;
      document.getElementById('saveAndCloseCardBtn').innerText = "Update Card";
      document.getElementById('saveAndAddAnotherBtn')?.classList.add('hidden');
      document.getElementById('cardDestinationDeckSelect')?.setAttribute('disabled', 'true');

      document.getElementById('customTopicInput').value = card.topic || card.case_title || '';
      document.getElementById('customCitationInput').value = card.rule_citation || card.citation || '';
      document.getElementById('customQuestionPromptInput').value = card.question_text || '';

      if (card.benchmark_fir) {
        setCardArchetype('CASE');
        document.getElementById('caseFactsInput').value = card.benchmark_fir.facts || '';
        document.getElementById('caseIssueInput').value = card.benchmark_fir.issue || '';
        document.getElementById('caseRulingInput').value = card.benchmark_fir.ruling || '';
        document.getElementById('caseRatioInput').value = card.benchmark_fir.ratio_doctrine || '';
      } else if (card.benchmark_codal_breakdown) {
        setCardArchetype('CODAL');
        document.getElementById('codalRuleInput').value = card.codal_provision_text || card.benchmark_codal_breakdown.operative_rule_summary || '';
        document.getElementById('codalRequisitesInput').value = card.benchmark_codal_breakdown.elements_requisites || '';
        document.getElementById('codalStatExceptionsInput').value = card.benchmark_codal_breakdown.statutory_exceptions || '';
        document.getElementById('codalJurisExceptionsInput').value = card.benchmark_codal_breakdown.jurisprudential_exceptions || '';
      } else if (card.benchmark_alac) {
        if (card.dimensionId === 10) setCardArchetype('PROCEDURAL');
        else setCardArchetype('ALAC');
        document.getElementById('alacAInput').value = card.benchmark_alac.p1_direct_answer || '';
        document.getElementById('alacLInput').value = card.benchmark_alac.p2_legal_basis || '';
        document.getElementById('alacAppInput').value = card.benchmark_alac.p3_analysis || '';
        document.getElementById('alacCInput').value = card.benchmark_alac.p4_conclusion || '';
      } else {
        setCardArchetype('SIMPLE');
        document.getElementById('simpleAnswerInput').value = card.model_answer || card.answer || '';
      }
    }

async function saveCustomCard(addAnother = false) {
      const saveBtn = document.getElementById('saveAndCloseCardBtn');

      // 1. Recitation active card in-place update handler
      if (saveBtn && saveBtn.innerText === "Update Card In Place") {
        await applyInPlaceCardUpdate();
        return;
      }

      // 2. Deck browser card in-place update handler
      if (saveBtn && saveBtn.innerText === "Update Deck Card" && editingBrowserCardContext) {
        await applyDeckBrowserCardUpdate();
        return;
      }

      // 3. Deck merge preview card update handler
      if (saveBtn && saveBtn.innerText === "Update Merge Card" && editingMergeCardContext) {
        await applyMergeCardUpdate();
        return;
      }

      // 4. Session debrief transcript card update handler
      if (saveBtn && saveBtn.innerText === "Update Debrief Card" && editingDebriefIndex !== null) {
        await applyDebriefCardUpdate();
        return;
      }

      // 3. Deck merge preview card update handler
      if (saveBtn && saveBtn.innerText === "Update Merge Card" && editingMergeCardContext) {
        await applyMergeCardUpdate();
        return;
      }

      // 4. Session debrief transcript card update handler
      if (saveBtn && saveBtn.innerText === "Update Debrief Card" && editingDebriefIndex !== null) {
        await applyDebriefCardUpdate();
        return;
      }
  if (currentCardStudioMode === 'BULK') {
    await processBulkImport();
    return;
  }

      const topic = document.getElementById('customTopicInput').value.trim();
      const citation = document.getElementById('customCitationInput').value.trim();
      const question = document.getElementById('customQuestionPromptInput').value.trim();

      if (!topic || !question) {
        alert("Please provide at least a Topic and a Question Prompt.");
        return;
      }

      const builtCard = {
        id: editingCardContext?.cardRef?.id || ('card_custom_' + Date.now()),
        topic: topic,
        rule_citation: citation || currentSubjectName,
        question_text: question,
        isCustom: true,
        subject: currentSubjectName
      };

      if (currentCardArchetype === 'CODAL') {
        builtCard.dimensionId = 2;
        builtCard.schemaType = 'CODAL';
        builtCard.exportTag = 'Essential Elements & Requisites';
        builtCard.codal_provision_text = document.getElementById('codalRuleInput').value.trim();
        builtCard.benchmark_codal_breakdown = {
          operative_rule_summary: document.getElementById('codalRuleInput').value.trim(),
          elements_requisites: document.getElementById('codalRequisitesInput').value.trim(),
          statutory_exceptions: document.getElementById('codalStatExceptionsInput').value.trim(),
          jurisprudential_exceptions: document.getElementById('codalJurisExceptionsInput').value.trim(),
          application_ratio: "Author-curated statutory requisite breakdown."
        };
      } else if (currentCardArchetype === 'CASE') {
        builtCard.dimensionId = 7;
        builtCard.schemaType = 'FIR';
        builtCard.isCase = true;
        builtCard.case_title = topic;
        builtCard.exportTag = 'Complete Case Brief (FIR)';
        builtCard.benchmark_fir = {
          facts: document.getElementById('caseFactsInput').value.trim(),
          issue: document.getElementById('caseIssueInput').value.trim(),
          ruling: document.getElementById('caseRulingInput').value.trim(),
          ratio_doctrine: document.getElementById('caseRatioInput').value.trim()
        };
      } else if (currentCardArchetype === 'ALAC') {
        builtCard.dimensionId = 9;
        builtCard.schemaType = 'ALAC';
        builtCard.exportTag = 'Bar Problem Hypothetical (ALAC)';
        builtCard.benchmark_alac = {
          p1_direct_answer: document.getElementById('alacAInput').value.trim(),
          p2_legal_basis: document.getElementById('alacLInput').value.trim(),
          p3_analysis: document.getElementById('alacAppInput').value.trim(),
          p4_conclusion: document.getElementById('alacCInput').value.trim()
        };
      } else if (currentCardArchetype === 'PROCEDURAL') {
        builtCard.dimensionId = 10;
        builtCard.schemaType = 'ALAC';
        builtCard.exportTag = 'Procedural Remedies & Bars';
        builtCard.benchmark_alac = {
          p1_direct_answer: document.getElementById('alacAInput').value.trim(),
          p2_legal_basis: document.getElementById('alacLInput').value.trim(),
          p3_analysis: document.getElementById('alacAppInput').value.trim(),
          p4_conclusion: document.getElementById('alacCInput').value.trim()
        };
      } else {
        builtCard.dimensionId = 1;
        builtCard.schemaType = 'ALAC';
        builtCard.exportTag = 'Author Curated Q&A';
        const ans = document.getElementById('simpleAnswerInput').value.trim();
        builtCard.benchmark_alac = {
          p1_direct_answer: ans,
          p2_legal_basis: citation || currentSubjectName,
          p3_analysis: ans,
          p4_conclusion: "Accurate recall confirmed."
        };
      }

      // CASE 0: Live session in-place update
      if (editingCardContext?.isLiveActiveCard && editingCardContext.itemRef) {
        Object.assign(editingCardContext.itemRef, builtCard);
        state.currentQuestionText = builtCard.question_text;
        state.currentBenchmarkPayload = builtCard;

        const qContainer = document.getElementById('questionContainer');
        const activeTopic = document.getElementById('activeTopicName');
        if (qContainer) qContainer.innerText = builtCard.question_text;
        if (activeTopic) activeTopic.innerText = `${builtCard.topic} (${builtCard.rule_citation})`;

        if (editingCardContext.deckId) {
          const deck = await dbGet('decks', editingCardContext.deckId);
          if (deck && deck.cards) {
            const idx = deck.cards.findIndex(c => c.id === builtCard.id || c.topic === builtCard.topic);
            if (idx !== -1) deck.cards[idx] = builtCard;
            await dbSave('decks', deck);
          }
        }

        await stampSubjectModifiedTimestamp();
        closeCardCreatorModal();
        alert("Card updated in-place! Live recitation session refreshed.");
        return;
      }

      // CASE 1: Updating existing card from Deck Browser
      if (editingCardContext?.deckId && editingCardContext.cardIndex !== undefined) {
        const deck = await dbGet('decks', editingCardContext.deckId);
        if (deck && deck.cards) {
          deck.cards[editingCardContext.cardIndex] = { ...deck.cards[editingCardContext.cardIndex], ...builtCard };
          await dbSave('decks', deck);
          await stampSubjectModifiedTimestamp();
          await renderDeckListUI();
          if (currentBrowsingDeckId === editingCardContext.deckId) {
            renderBrowserCardsList();
          }
        }
        closeCardCreatorModal();
        alert("Card updated successfully!");
        return;
      }

      // CASE 2: Adding brand new card
      const destSelect = document.getElementById('cardDestinationDeckSelect').value;

      if (destSelect === '__NEW__') {
        const titleInput = document.getElementById('newDeckTitleInput').value.trim() || `${currentSubjectName} - Custom Cards`;
        const newDeck = {
          id: 'deck_' + Date.now(),
          subject: currentSubjectName,
          title: titleInput,
          createdAt: new Date().toISOString(),
          cards: [builtCard]
        };
        await dbSave('decks', newDeck);
        await populateCardStudioDeckSelector(newDeck.id);
      } else {
        const existingDeck = await dbGet('decks', destSelect);
        if (existingDeck) {
          if (!existingDeck.cards) existingDeck.cards = [];
          existingDeck.cards.push(builtCard);
          await dbSave('decks', existingDeck);
        }
      }

      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (currentBrowsingDeckId) {
        renderBrowserCardsList();
      }

      if (addAnother) {
        document.getElementById('customTopicInput').value = '';
        document.getElementById('customQuestionPromptInput').value = '';
        document.getElementById('codalRequisitesInput').value = '';
        document.getElementById('caseFactsInput').value = '';
        document.getElementById('caseIssueInput').value = '';
        document.getElementById('caseRulingInput').value = '';
        document.getElementById('alacAInput').value = '';
        document.getElementById('alacAppInput').value = '';
        document.getElementById('simpleAnswerInput').value = '';
        document.getElementById('customTopicInput').focus();
        document.getElementById('cardStudioFooterStatus').innerText = "Card saved! Ready for next.";
      } else {
        closeCardCreatorModal();
        alert("Card saved to deck successfully!");
      }
    }

    function previewBulkImportCount() {
      const raw = document.getElementById('bulkImportRawText')?.value.trim() || '';
      const statusEl = document.getElementById('bulkParseStatus');
      if (!raw) {
        if (statusEl) statusEl.innerText = "0 card rows detected";
        return 0;
      }
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (statusEl) statusEl.innerText = `${lines.length} card row(s) detected and ready to ingest`;
      return lines.length;
    }

    async function processBulkImport() {
      const raw = document.getElementById('bulkImportRawText')?.value.trim() || '';
      if (!raw) {
        alert("Please paste your CSV, TSV, or Anki export lines.");
        return;
      }

      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const parsedCards = [];

      lines.forEach((line, idx) => {
        let sanitizedLine = line
          .replace(/\[sound:[^\]]+\]/gi, '')
          .replace(/<br\s*[\/]?>/gi, '\n')
          .replace(/<[^>]+>/gi, '')
          .trim();

        let parts = sanitizedLine.split('\t');
        if (parts.length < 2) parts = sanitizedLine.split(',');

        if (parts.length >= 2) {
          const topic = parts[0].trim();
          const question = parts[1].trim();
          const answer = parts[2] ? parts[2].trim() : "Model answer not provided.";
          const citation = parts[3] ? parts[3].trim() : currentSubjectName;

          parsedCards.push({
            id: `card_bulk_${Date.now()}_${idx}`,
            topic: topic,
            rule_citation: citation,
            question_text: question,
            isCustom: true,
            dimensionId: 9,
            schemaType: 'ALAC',
            exportTag: 'Imported Reviewer Card',
            benchmark_alac: {
              p1_direct_answer: answer,
              p2_legal_basis: citation,
              p3_analysis: answer,
              p4_conclusion: "Substantial recall confirmed."
            }
          });
        }
      });

      if (parsedCards.length === 0) {
        alert("Could not parse rows. Ensure each line has at least: Topic [TAB] Question [TAB] Model Answer");
        return;
      }

      const destSelect = document.getElementById('cardDestinationDeckSelect').value;

      if (destSelect === '__NEW__') {
        const titleInput = document.getElementById('newDeckTitleInput').value.trim() || `${currentSubjectName} - Bulk Deck (${parsedCards.length} Cards)`;
        const newDeck = {
          id: 'deck_' + Date.now(),
          subject: currentSubjectName,
          title: titleInput,
          createdAt: new Date().toISOString(),
          cards: parsedCards
        };
        await dbSave('decks', newDeck);
      } else {
        const existingDeck = await dbGet('decks', destSelect);
        if (existingDeck) {
          if (!existingDeck.cards) existingDeck.cards = [];
          existingDeck.cards.push(...parsedCards);
          await dbSave('decks', existingDeck);
        }
      }

      await stampSubjectModifiedTimestamp();
      await renderDeckListUI();
      if (currentBrowsingDeckId) renderBrowserCardsList();
      closeCardCreatorModal();
      alert(`Success! Imported ${parsedCards.length} cards into your deck.`);
    }

    // =========================================================================
    // PHASE 4: REMNOTE-STYLE CLOZE DELETION ENGINE
    // =========================================================================
    let activeSelectionTextarea = null;

    function handleStudioSelectionEvent(e) {
      const activeEl = document.activeElement;
      const toolbar = document.getElementById('clozeFloatingToolbar');
      if (!toolbar) return;

      if (activeEl && (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && activeEl.type === 'text'))) {
        if (!activeEl.closest('#cardCreatorModal')) {
          toolbar.classList.add('hidden');
          return;
        }

        const selStart = activeEl.selectionStart;
        const selEnd = activeEl.selectionEnd;

        if (selStart !== undefined && selEnd !== undefined && selEnd > selStart) {
          activeSelectionTextarea = activeEl;
          const elRect = activeEl.getBoundingClientRect();

          const topPos = Math.max(12, elRect.top - 38);
          const leftPos = Math.min(window.innerWidth - 270, Math.max(20, elRect.left + 15));

          toolbar.style.top = `${topPos}px`;
          toolbar.style.left = `${leftPos}px`;
          toolbar.classList.remove('hidden');
          return;
        }
      }
      toolbar.classList.add('hidden');
    }

    document.addEventListener('selectionchange', handleStudioSelectionEvent);
    document.addEventListener('mouseup', handleStudioSelectionEvent);

    function applyClozeToActiveSelection(withHint = false) {
      const ta = activeSelectionTextarea || document.activeElement;
      if (!ta || (ta.tagName !== 'TEXTAREA' && ta.tagName !== 'INPUT')) return;

      const selStart = ta.selectionStart;
      const selEnd = ta.selectionEnd;
      if (selStart === undefined || selEnd === undefined) return;

      const fullText = ta.value;
      let selectedText = fullText.substring(selStart, selEnd);
      if (!selectedText || !selectedText.trim()) {
        selectedText = "phrase";
      }

      const matches = fullText.match(/\{\{c(\d+)::/g) || [];
      let maxNum = 0;
      matches.forEach(m => {
        const num = parseInt(m.replace('{{c', '').replace('::', ''), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      });
      const nextClozeNum = maxNum + 1;

      let replacement = `{{c${nextClozeNum}::${selectedText}}}`;
      if (withHint) {
        const hint = prompt("Enter an optional hint for this cloze deletion (e.g., 'statutory threshold' or 'legal basis'):", "");
        if (hint && hint.trim()) {
          replacement = `{{c${nextClozeNum}::${selectedText}::${hint.trim()}}}`;
        }
      }

      ta.value = fullText.substring(0, selStart) + replacement + fullText.substring(selEnd);
      document.getElementById('clozeFloatingToolbar')?.classList.add('hidden');

      const newCursorPos = selStart + replacement.length;
      ta.focus();
      ta.setSelectionRange(newCursorPos, newCursorPos);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && activeEl.type === 'text'))) {
          if (activeEl.closest('#cardCreatorModal')) {
            e.preventDefault();
            activeSelectionTextarea = activeEl;
            applyClozeToActiveSelection(false);
          }
        }
      }
    });

    // =========================================================================
    // PHASE 6: STATUTORY ANTI-TRUNCATION & SUBSTANTIVE ALAC HEALERS
    // =========================================================================
    function healTruncatedStatutoryText(text, topicHint) {
      if (!text || !text.trim()) return text;
      let trimmed = text.trim();

      const endsDangling = /(:|—|-|\b(?:following|viz|as follows)\s*:?)$/i.test(trimmed);
      if (!endsDangling) return trimmed;

      const canonicalMatch = retrieveVerbatimProvision(topicHint || trimmed);
      if (canonicalMatch && canonicalMatch.length > trimmed.length) {
        return canonicalMatch;
      }
      return trimmed;
    }

    function healTruncatedAlacBasis(basisText, fallbackSubstantiveText) {
      if (!basisText || !basisText.trim()) return fallbackSubstantiveText || basisText;
      const cleanBasis = basisText.trim();

      const isBareCitation = cleanBasis.length < 110 &&
        /^(?:Rule|Section|Sec\.|Article|Art\.|R\.A\.|A\.M\.)\s+\d+/i.test(cleanBasis) &&
        !/\b(?:provides|states|empowered|held|prohibits|mandates|shall|may|requires)\b/i.test(cleanBasis);

      if (isBareCitation && fallbackSubstantiveText) {
        const canonical = retrieveVerbatimProvision(fallbackSubstantiveText);
        if (canonical) {
          return `Under ${cleanBasis}, ${canonical}`;
        }
      }
      return cleanBasis;
    }
  