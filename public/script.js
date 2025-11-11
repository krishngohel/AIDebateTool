// script.js – relaxed on-topic + logs every turn, with client word-limits + live counter + side picker (modal)
// Fixes: side modal appears only after topic is chosen; side buttons advance to next stage
document.addEventListener("DOMContentLoaded", () => {
  const SETTINGS_KEY = "debate_user_settings_v1";
  let settings = null;
  try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch {}
  if (!settings) { window.location.replace("/"); return; }

  // Elements
  const chatBox        = document.getElementById("chatBox");
  const studentInput   = document.getElementById("studentInput");
  const submitBtn      = document.getElementById("submitBtn");
  const studentThought = document.getElementById("studentThought");
  const aiThought      = document.getElementById("aiThought");
  const lightBulb      = document.getElementById("lightBulb");
  const roundTracker   = document.getElementById("roundTracker");

  // Popups
  const finishPopup    = document.getElementById("popup");
  const welcomePopup   = document.getElementById("welcomePopup");
  const understoodBtn  = document.getElementById("understoodBtn");
  const topicPopup     = document.getElementById("topicPopup");
  const confirmTopicBtn= document.getElementById("confirmTopicBtn");
  const topicButtons   = Array.from(document.querySelectorAll(".topic-btn"));

  // HUD
  const hud        = document.getElementById("hud");
  const hudFill    = document.getElementById("hudFill");
  const hudLabelEl = document.getElementById("hudLabel");

  // Session
  let sessionId = null;

  // State
  let currentRound = 1;
  const MAX_ROUNDS = 3;
  let finishedReady = false;
  let selectedTopic = settings?.topic || null;
  let lastHUD = { meter: 50, leader: "tied", label: "Neck and neck" };

  // Client word-limits (mirror server)
  function mapDifficultyToBehavior(diff){
    switch (diff) {
      case "Beginner":     return { maxWords: 90 };
      case "Intermediate": return { maxWords: 90 };
      case "Normal":       return { maxWords: 90 };
      case "Hard":         return { maxWords:130 };
      case "Extreme":      return { maxWords:200 };
      default:             return { maxWords: 90 };
    }
  }
  const behavior = mapDifficultyToBehavior(settings?.difficulty || "Normal");

  // Helpers
  const safe = (el, cb) => { if (el) cb(el); };
  const now = () => performance.now();

  function updateRoundDisplay() {
    safe(roundTracker, el => el.textContent = `Round ${currentRound} of ${MAX_ROUNDS}`);
  }
  function addMessage(sender, text) {
    if (!chatBox) return;
    const div = document.createElement("div");
    div.className = `chat-message ${sender === "AI" ? "ai" : "student"}`;
    div.innerHTML = `<strong>${sender}:</strong> ${text}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
  function showBubble(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
  }
  function updateHUD(meter=50, label="Neck and neck") {
    if (!hud || !hudFill || !hudLabelEl) return;
    hud.classList.remove("hidden");
    const clamped = Math.max(0, Math.min(100, meter));
    hudFill.style.width = `${clamped}%`;
    hudLabelEl.textContent = label;
  }
  updateHUD(50, "Neck and neck");

  function makeLeadReasoning(round, hudObj, stance, topic) {
    const who = hudObj?.leader || "tied";
    const t = topic ? ` on “${topic}”` : "";
    const r1 = {
      ai:      `After Round 1${t}, the AI is slightly ahead for clearer structure and examples.`,
      student: `After Round 1${t}, the student leads with relatable reasons and personal experience.`,
      tied:    `After Round 1${t}, it’s very close — both sides made clear opening points.`
    };
    const r2 = {
      ai:      `After Round 2${t}, the AI pulled ahead with tighter logic and focus.`,
      student: `After Round 2${t}, the student is ahead with stronger support and real-life links.`,
      tied:    `After Round 2${t}, it’s still neck and neck — strong points on both sides.`
    };
    const r3 = {
      ai:      `After the final round${t}, the AI edges ahead thanks to organized reasoning.`,
      student: `After the final round${t}, the student leads with convincing, well-supported ideas.`,
      tied:    `After the final round${t}, it’s very close — thoughtful arguments from both sides.`
    };
    let bank = r1;
    if (round >= 3) bank = r3; else if (round === 2) bank = r2;
    if (who === "ai") return bank.ai;
    if (who === "student") return bank.student;
    if (stance === "agree") return bank.student;
    if (stance === "disagree") return bank.ai;
    return bank.tied;
  }

  // ===== Live word counter =====
  const counter = document.createElement("div");
  counter.id = "wordCounter";
  counter.style.fontSize = "12px";
  counter.style.marginTop = "6px";
  counter.style.opacity = "0.8";
  counter.textContent = `0 / ${behavior.maxWords} words`;
  if (studentInput && studentInput.parentNode) {
    studentInput.parentNode.insertBefore(counter, studentInput.nextSibling);
  }
  function currentWordCount(str) {
    return (str.match(/\b[\w']+\b/g) || []).length;
  }
  function refreshCounter() {
    const used = currentWordCount(studentInput.value || "");
    counter.textContent = `${used} / ${behavior.maxWords} words`;
    const over = used > behavior.maxWords;
    counter.style.color = over ? "#b91c1c" : "";
    submitBtn.disabled = over || submitBtn.dataset.locked === "1";
  }
  studentInput.addEventListener("input", refreshCounter);
  refreshCounter();

  // ===== Side-selection popup (true modal overlay) =====
  const sidePopup = document.createElement("div");
  sidePopup.id = "sidePopup";
  // start truly hidden (display:none) to avoid CSS class dependency
  sidePopup.setAttribute("style",
    "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:9999;");
  sidePopup.innerHTML = `
    <div style="background:#16151a;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.5);padding:28px;min-width:320px;max-width:520px;">
      <h2 style="margin:0 0 8px 0;">Pick your side</h2>
      <p style="margin:0 0 16px 0;opacity:.9">For the topic “<span id="sideTopic"></span>”, are you <strong>FOR</strong> it or <strong>AGAINST</strong> it?</p>
      <div style="display:flex;gap:10px;margin-bottom:8px;">
        <button id="sideFor" class="btn-primary" type="button">I’m FOR</button>
        <button id="sideAgainst" class="btn-secondary" type="button">I’m AGAINST</button>
      </div>
      <small class="muted">The AI will argue the opposite side to keep the debate interesting.</small>
    </div>`;
  document.body.appendChild(sidePopup);

  function showSidePopup() {
    const span = sidePopup.querySelector("#sideTopic");
    if (span) span.textContent = selectedTopic || "";
    sidePopup.style.display = "flex";
  }
  function hideSidePopup() {
    sidePopup.style.display = "none";
  }

  // After side chosen → unlock UI + start session + intro line
  async function afterSideChosen() {
    hideSidePopup();
    topicPopup.classList.add("hidden");
    studentInput.disabled = false;
    submitBtn.disabled = false;
    submitBtn.dataset.locked = "0";
    refreshCounter();
    studentInput.focus();

    const opp = settings.side === 'pro' ? 'AGAINST' : settings.side === 'con' ? 'FOR' : 'OPPOSITE';
    addMessage(
      "AI",
      `Great! We’ll debate: “${selectedTopic}”. You are **${(settings.side || '').toUpperCase()}**; I’ll argue the **${opp}** side. Keep arguments school-appropriate. 👍`
    );

    await startSession();
  }

  // Bind side buttons (ensure type="button" so forms don’t swallow clicks)
  sidePopup.querySelector("#sideFor").addEventListener("click", async (e) => {
    e.preventDefault();
    settings.side = "pro";
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    await afterSideChosen();
  });
  sidePopup.querySelector("#sideAgainst").addEventListener("click", async (e) => {
    e.preventDefault();
    settings.side = "con";
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    await afterSideChosen();
  });

  // ===== Session APIs =====
  async function startSession() {
    const resp = await fetch("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name: settings.firstName,
        last_initial: settings.lastInitial,
        grade: settings.grade,
        difficulty: settings.difficulty,
        topic: selectedTopic,
        side: settings.side || null
      })
    });
    const data = await resp.json();
    sessionId = data.session_id;
  }
  async function logTurn(payload) {
    if (!sessionId) return;
    await fetch("/api/session/logTurn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, ...payload })
    });
  }
  async function finishSession(finalHud, violationsTotal=0) {
    if (!sessionId) return;
    await fetch("/api/session/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        winner_final: finalHud?.leader || "tied",
        hud_avg: null,
        hud_last: finalHud?.meter ?? null,
        violations_total: violationsTotal
      })
    });
  }

  async function callDebateAPI(message){
    const resp = await fetch("/api/debate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        difficulty: settings?.difficulty || "Normal",
        round: currentRound,
        topic: selectedTopic || null,
        studentSide: settings?.side || null,
        studentInfo: {
          firstName: settings.firstName,
          lastInitial: settings.lastInitial,
          grade: settings.grade,
          difficulty: settings.difficulty,
          topic: selectedTopic || null
        }
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "API error");
    return data;
  }
  async function callExplainAPI(student, reply){
    const resp = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student, reply })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Explain error");
    return data;
  }
  function outlineToText(outline, fallbackClaim) {
    const claim = outline?.extracted_claim || fallbackClaim || "";
    const steps = Array.isArray(outline?.steps) ? outline.steps.slice(0, 4) : [];
    const strategy = outline?.strategy ? `\n\nStrategy: ${outline.strategy}` : "";
    const bullets = steps.length
      ? steps.map(s => `• ${s}`).join("\n")
      : "• 🔍 Identify main idea\n• 🎯 Give one reason\n• 🧩 Add example\n• 🤝 Suggest compromise";
    return `${claim ? `“${claim}”\n\n` : ""}${bullets}${strategy}`;
  }

  // ===== Initial UI state =====
  safe(finishPopup, el => el.classList.add("hidden"));
  safe(topicPopup,  el => el.classList.add("hidden"));
  safe(welcomePopup, el => el.classList.remove("hidden"));

  studentInput.disabled = true;
  submitBtn.disabled = true;
  submitBtn.dataset.locked = "1";

  understoodBtn.addEventListener("click", () => {
    welcomePopup.classList.add("hidden");
    topicPopup.classList.remove("hidden");
    confirmTopicBtn.disabled = true;
  });

  topicButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      topicButtons.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedTopic = btn.getAttribute("data-topic");
      confirmTopicBtn.disabled = !selectedTopic;
    });
  });

  // After topic chosen, show side modal (don’t unlock yet)
  confirmTopicBtn.addEventListener("click", () => {
    if (!selectedTopic) return;
    const merged = { ...(settings || {}), topic: selectedTopic };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    settings = merged;
    // Keep topic modal visible behind? We hide it after side is picked.
    showSidePopup();
  });

  // ===== Finish popup =====
  function showResultPopup(hudObj) {
    if (!finishPopup) return;
    finishPopup.classList.remove("hidden");
    const popupTitle = finishPopup.querySelector(".popup-title");
    const popupMsg   = finishPopup.querySelector(".popup-message");
    const winner     = hudObj?.leader || "tied";
    let title = "", msg = "";
    if (winner === "student") { title = "🎉 You Won!"; msg = "Excellent job! Your arguments were strong, clear, and persuasive."; }
    else if (winner === "ai") { title = "🤖 The AI Won This Time!"; msg = "Great effort! Your ideas were thoughtful. Keep practicing your reasoning!"; }
    else { title = "🤝 It’s a Tie!"; msg = "Both sides made solid points and stayed on topic. Nice work!"; }
    if (popupTitle) popupTitle.textContent = title;
    if (popupMsg)   popupMsg.textContent   = msg;
    const anyBtn = finishPopup.querySelector("button");
    if (anyBtn) {
      anyBtn.textContent = "Back to Welcome";
      anyBtn.onclick = () => {
        localStorage.removeItem(SETTINGS_KEY);
        window.location.href = "/";
      };
    }
  }

  // ===== Main flow =====
  submitBtn.addEventListener("click", async () => {
    if (finishedReady) { showResultPopup(lastHUD); return; }

    const text = (studentInput.value || "").trim();
    if (!text) return;
    if (!selectedTopic) { topicPopup.classList.remove("hidden"); return; }
    if (!settings.side) { showSidePopup(); return; }

    // client word limit
    const used = (text.match(/\b[\w']+\b/g) || []).length;
    if (used > behavior.maxWords) {
      alert(`Please keep your argument under ${behavior.maxWords} words for ${settings.difficulty || "Normal"}. You used ${used}.`);
      return;
    }

    showBubble(studentThought, `Student: ${text}`);
    showBubble(aiThought, "AI: Thinking…");
    lightBulb.classList.remove("on");
    addMessage(settings?.firstName || "Student", text);
    studentInput.value = "";
    refreshCounter();

    const t0 = now();
    try {
      const data = await callDebateAPI(text);
      const latency = Math.round(now() - t0);

      if (data.hint) addMessage("AI", data.hint);

      if (data.violation) {
        const msg = data.instructions || "Let's keep this discussion school-safe.";
        addMessage("AI", msg);
        showBubble(aiThought, `AI: ${msg}`);

        await logTurn({
          round: currentRound,
          student_text: text,
          ai_reply_text: msg,
          hud_meter: data.hud?.meter ?? "",
          hud_leader: data.hud?.leader ?? "",
          latency_ms: latency,
          status: "violation",
          category: data.category || "sensitive"
        });

        if (data.endDebate) {
          await finishSession(lastHUD);
          studentInput.disabled = true;
          submitBtn.textContent = "Finish Debate";
          finishedReady = true;
        }
        return;
      }

      // normal reply
      addMessage("AI", data.reply);
      if (data.hud) { updateHUD(data.hud.meter, data.hud.label); lastHUD = data.hud; }

      const reasoning = makeLeadReasoning(currentRound, data.hud, data.stance, selectedTopic);
      showBubble(aiThought, reasoning);

      try {
        const outline = await callExplainAPI(text, data.reply);
        showBubble(studentThought, outlineToText(outline, text));
      } catch {}

      lightBulb.classList.add("on");
      setTimeout(() => lightBulb.classList.remove("on"), 900);

      await logTurn({
        round: currentRound,
        student_text: text,
        ai_reply_text: data.reply,
        hud_meter: data.hud?.meter ?? "",
        hud_leader: data.hud?.leader ?? "",
        latency_ms: latency,
        status: "ok",
        category: ""
      });

      if (data.endDebate) {
        await finishSession(data.hud);
        studentInput.disabled = true;
        submitBtn.textContent = "Finish Debate";
        finishedReady = true;
      } else {
        currentRound = data.nextRound || currentRound + 1;
        updateRoundDisplay();
      }
    } catch (err) {
      addMessage("AI", err.message || "Network error — please try again.");
      showBubble(aiThought, "AI: (error) Please try again.");
    }
  });

  updateRoundDisplay();
  addMessage("AI", `Welcome, ${settings.firstName} ${settings.lastInitial}. You chose ${settings.difficulty || "Normal"}.`);
});
