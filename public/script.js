// script.js – welcome popup → topic popup → debate (3 rounds)
// + safe filters + win meter + dynamic reasoning + finish popup
// + session start/log/finish with per-session CSV/JSON files
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

  // State
  let currentRound = 1;
  const MAX_ROUNDS = 3;
  let finishedReady = false;
  let selectedTopic = settings?.topic || null;
  let lastHUD = { meter: 50, leader: "tied", label: "Neck and neck" };
  let sessionId = null;
  let violationsTotal = 0;

  // ---------- Helpers ----------
  const safe = (el, cb) => { if (el) cb(el); };

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

  function mapDifficultyToBehavior(diff){
    switch (diff) {
      case "Beginner":     return { maxWords: 90 };
      case "Intermediate": return { maxWords: 90 };
      case "Normal":       return { maxWords: 90 };
      case "Hard":         return { maxWords:110 };
      case "Extreme":      return { maxWords:130 };
      default:             return { maxWords: 90 };
    }
  }
  const behavior = mapDifficultyToBehavior(settings?.difficulty || "Normal");

  // HUD
  function updateHUD(meter, label) {
    if (!hud || !hudFill || !hudLabelEl) return;
    hud.classList.remove("hidden");
    const clamped = Math.max(0, Math.min(100, meter ?? 50));
    hudFill.style.width = `${clamped}%`;
    hudLabelEl.textContent = label || "Neck and neck";
    const bar = hud.querySelector(".hud-bar");
    if (bar) bar.setAttribute("aria-valuenow", String(clamped));
  }
  updateHUD(50, "Neck and neck");

  // Dynamic reasoning per round
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

  // ---------- API wrappers ----------
  async function callDebateAPI(message){
    const t0 = performance.now();
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
    data._latency_ms = Math.round(performance.now() - t0);
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

  // Session logging APIs
  async function startSession() {
    const payload = {
      first_name: settings.firstName,
      last_initial: settings.lastInitial,
      grade: settings.grade,
      difficulty: settings.difficulty,
      topic: selectedTopic
    };
    const r = await fetch('/api/session/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || 'Failed to start session');
    sessionId = j.session_id;
  }

  async function logTurn({ round, student_text, ai_reply_text, hud_meter, hud_leader, latency_ms }) {
    if (!sessionId) return; // if missing, skip silently
    await fetch('/api/session/logTurn', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        session_id: sessionId,
        round, student_text, ai_reply_text,
        hud_meter, hud_leader, latency_ms
      })
    });
  }

  async function finishSession(finalLeader) {
    if (!sessionId) return;
    const allMeters = document.querySelector('.hud-bar') ? [] : []; // placeholder if you later track locally
    const payload = {
      session_id: sessionId,
      winner_final: finalLeader || 'tied',
      violations_total: violationsTotal,
      hud_avg: null,  // could compute client-side if you store history
      hud_last: lastHUD?.meter ?? null
    };
    await fetch('/api/session/finish', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
  }

  // ---------- Result Popup ----------
  function showResultPopup(hudObj) {
    if (!finishPopup) return;
    finishPopup.classList.remove("hidden");

    const popupTitle = finishPopup.querySelector(".popup-title");
    const popupMsg   = finishPopup.querySelector(".popup-message");
    const winner     = hudObj?.leader || "tied";
    let title = "", msg = "";

    if (winner === "student") {
      title = "🎉 You Won!";
      msg   = "Excellent job! Your arguments were strong, clear, and persuasive.";
    } else if (winner === "ai") {
      title = "🤖 The AI Won This Time!";
      msg   = "Great effort! Your ideas were thoughtful. Keep practicing your reasoning!";
    } else {
      title = "🤝 It’s a Tie!";
      msg   = "Both sides made solid points and stayed on topic. Nice work!";
    }

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

  // ---------- Initial popups ----------
  if (finishPopup) finishPopup.classList.add("hidden");
  if (topicPopup)  topicPopup.classList.add("hidden");
  if (welcomePopup) welcomePopup.classList.remove("hidden");

  studentInput.disabled = true;
  submitBtn.disabled = true;

  // Welcome → Topic
  if (understoodBtn) {
    understoodBtn.addEventListener("click", () => {
      welcomePopup.classList.add("hidden");
      topicPopup.classList.remove("hidden");
      if (confirmTopicBtn) confirmTopicBtn.disabled = true;
    });
  }

  topicButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      topicButtons.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedTopic = btn.getAttribute("data-topic");
      if (confirmTopicBtn) confirmTopicBtn.disabled = !selectedTopic;
    });
  });

  if (confirmTopicBtn) {
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

      // Start session on topic confirmation
      try { await startSession(); }
      catch (e) { console.warn('Session start failed:', e?.message); }
    });
  }

  // ---------- Main Debate Flow ----------
  submitBtn.addEventListener("click", async () => {
    // If already finished, clicking shows the result & finalizes session
    if (finishedReady) {
      try { await finishSession(lastHUD?.leader || 'tied'); } catch {}
      showResultPopup(lastHUD);
      return;
    }

    const text = (studentInput.value || "").trim();
    if (!text) return;

    if (!selectedTopic) {
      topicPopup.classList.remove("hidden");
      return;
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > behavior.maxWords) {
      alert(`Please keep your argument under ${behavior.maxWords} words.`);
      return;
    }

    // Thinking UI
    showBubble(studentThought, `Student: ${text}`);
    showBubble(aiThought, "AI: Thinking…");
    lightBulb.classList.remove("on");
    addMessage(settings?.firstName || "Student", text);
    studentInput.value = "";

    try {
      const data = await callDebateAPI(text);

      // Violations (sensitive/off-topic)
      if (data.violation) {
        violationsTotal += 1;
        const msg = data.instructions || "Let's stay appropriate and on topic.";
        addMessage("AI", msg);
        showBubble(aiThought, `AI: ${msg}`);
        if (data.hud) { updateHUD(data.hud.meter, data.hud.label); lastHUD = data.hud; }

        if (data.endDebate) {
          studentInput.disabled = true;
          submitBtn.textContent = "Finish Debate";
          finishedReady = true;
        }
        return;
      }

      // AI reply → chat
      addMessage("AI", data.reply);

      // Update HUD after AI reply
      if (data.hud) { updateHUD(data.hud.meter, data.hud.label); lastHUD = data.hud; }

      // Thought bubble shows round-aware lead reasoning
      const reasoning = makeLeadReasoning(currentRound, data.hud, data.stance, selectedTopic);
      showBubble(aiThought, reasoning);

      // Student bubble: outline
      try {
        const outline = await callExplainAPI(text, data.reply);
        showBubble(studentThought, outlineToText(outline, text));
      } catch {}

      // Log this turn to the session file
      try {
        await logTurn({
          round: currentRound,
          student_text: text,
          ai_reply_text: data.reply,
          hud_meter: data?.hud?.meter ?? null,
          hud_leader: data?.hud?.leader ?? null,
          latency_ms: data?._latency_ms ?? null
        });
      } catch (e) {
        console.warn('logTurn failed:', e?.message);
      }

      // Blink bulb
      lightBulb.classList.add("on");
      setTimeout(() => lightBulb.classList.remove("on"), 900);

      // Rounds
      if (data.endDebate) {
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

  // Greeting
  updateRoundDisplay();
  addMessage("AI", `Welcome, ${settings.firstName} ${settings.lastInitial}. You chose ${settings.difficulty || "Normal"}.`);
});
