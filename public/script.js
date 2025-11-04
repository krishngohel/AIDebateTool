// script.js – relaxed on-topic + log every turn (ok/violation)
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

  // API
  async function startSession() {
    const resp = await fetch("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name: settings.firstName,
        last_initial: settings.lastInitial,
        grade: settings.grade,
        difficulty: settings.difficulty,
        topic: selectedTopic
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

  // UI flow
  safe(finishPopup, el => el.classList.add("hidden"));
  safe(topicPopup,  el => el.classList.add("hidden"));
  safe(welcomePopup, el => el.classList.remove("hidden"));

  studentInput.disabled = true;
  submitBtn.disabled = true;

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

  confirmTopicBtn.addEventListener("click", async () => {
    if (!selectedTopic) return;
    const merged = { ...(settings || {}), topic: selectedTopic };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    settings = merged;
    topicPopup.classList.add("hidden");
    studentInput.disabled = false;
    submitBtn.disabled = false;
    studentInput.focus();
    addMessage("AI", `Great! We'll debate: “${selectedTopic}”. Keep arguments school-appropriate and on topic. 👍`);
    await startSession();
  });

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

  submitBtn.addEventListener("click", async () => {
    if (finishedReady) { showResultPopup(lastHUD); return; }

    const text = (studentInput.value || "").trim();
    if (!text) return;
    if (!selectedTopic) { topicPopup.classList.remove("hidden"); return; }

    // visual thinking
    showBubble(studentThought, `Student: ${text}`);
    showBubble(aiThought, "AI: Thinking…");
    lightBulb.classList.remove("on");
    addMessage(settings?.firstName || "Student", text);
    studentInput.value = "";

    const t0 = now();
    try {
      const data = await callDebateAPI(text);
      const latency = Math.round(now() - t0);

      // Soft hint (no violation)
      if (data.hint) {
        addMessage("AI", data.hint);
      }

      // If moderation violation
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

      // Normal reply
      addMessage("AI", data.reply);
      if (data.hud) {
        updateHUD(data.hud.meter, data.hud.label);
        lastHUD = data.hud;
      }

      // Thought bubbles
      const reasoning = makeLeadReasoning(currentRound, data.hud, data.stance, selectedTopic);
      showBubble(aiThought, reasoning);

      try {
        const outline = await callExplainAPI(text, data.reply);
        showBubble(studentThought, outlineToText(outline, text));
      } catch {}

      lightBulb.classList.add("on");
      setTimeout(() => lightBulb.classList.remove("on"), 900);

      // Log successful turn
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

      // Rounds
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
