// script.js – includes win meter HUD below submit button
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
  const popup          = document.getElementById("popup");
  const newAttemptBtn  = document.getElementById("newAttemptBtn");
  const welcomePopup   = document.getElementById("welcomePopup");
  const understoodBtn  = document.getElementById("understoodBtn");
  const topicPopup     = document.getElementById("topicPopup");
  const confirmTopicBtn= document.getElementById("confirmTopicBtn");
  const topicButtons   = Array.from(document.querySelectorAll(".topic-btn"));

  // HUD elements
  const hud        = document.getElementById("hud");
  const hudFill    = document.getElementById("hudFill");
  const hudLabelEl = document.getElementById("hudLabel");

  // State
  let currentRound = 1;
  const MAX_ROUNDS = 3;
  let finishedReady = false;
  let selectedTopic = settings?.topic || null;
  let sensitiveStrikesThisRound = 0;

  // Helpers
  function updateRoundDisplay() {
    if (roundTracker) roundTracker.textContent = `Round ${currentRound} of ${MAX_ROUNDS}`;
  }
  function addMessage(sender, text) {
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
  function showPopup() { popup.classList.remove("hidden"); }

  // HUD updater
  function updateHUD(meter, label) {
    if (!hud || !hudFill || !hudLabelEl) return;
    hud.classList.remove("hidden");
    const clamped = Math.max(0, Math.min(100, meter | 0));
    hudFill.style.width = `${clamped}%`;
    hudLabelEl.textContent = label || "Neck and neck";
    const bar = hud.querySelector(".hud-bar");
    if (bar) bar.setAttribute("aria-valuenow", String(clamped));
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

  // === API calls ===
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
      : "• 🔍 Identify the main idea\n• 🎯 Choose one clear reason\n• 🧩 Give a simple example\n• 🤝 Offer a fair compromise";
    return `${claim ? `“${claim}”\n\n` : ""}${bullets}${strategy}`;
  }

  // === Return to welcome ===
  newAttemptBtn.addEventListener("click", () => {
    localStorage.removeItem(SETTINGS_KEY);
    window.location.href = "/";
  });

  // === Welcome → Topic flow ===
  studentInput.disabled = true;
  submitBtn.disabled = true;
  welcomePopup.classList.remove("hidden");

  understoodBtn.addEventListener("click", () => {
    welcomePopup.classList.add("hidden");
    topicPopup.classList.remove("hidden");
  });

  topicButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      topicButtons.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedTopic = btn.getAttribute("data-topic");
      confirmTopicBtn.disabled = !selectedTopic;
    });
  });

  confirmTopicBtn.addEventListener("click", () => {
    if (!selectedTopic) return;
    const merged = { ...(settings || {}), topic: selectedTopic };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    settings = merged;
    topicPopup.classList.add("hidden");
    studentInput.disabled = false;
    submitBtn.disabled = false;
    studentInput.focus();
    addMessage("AI", `Great! We'll debate: “${selectedTopic}”. Keep arguments school-appropriate and on topic. 👍`);
  });

  // === Main debate loop ===
  submitBtn.addEventListener("click", async () => {
    if (finishedReady) { showPopup(); return; }

    const text = (studentInput.value || "").trim();
    if (!text) return;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > behavior.maxWords) {
      alert(`Please keep your argument under ${behavior.maxWords} words.`);
      return;
    }
    if (!selectedTopic) {
      topicPopup.classList.remove("hidden");
      return;
    }

    showBubble(studentThought, `Student: ${text}`);
    showBubble(aiThought, "AI: Thinking…");
    lightBulb.classList.remove("on");
    addMessage(settings?.firstName || "Student", text);
    studentInput.value = "";

    try {
      const data = await callDebateAPI(text);

      // === Update Win Meter ===
      if (data.hud) updateHUD(data.hud.meter, data.hud.label);

      // === Sensitive / Off-topic checks ===
      if (data.violation) {
        const msg = data.instructions || "Let's keep things school-safe.";
        showBubble(aiThought, `AI: ${msg}`);
        addMessage("AI", msg);
        lightBulb.classList.add("on");
        setTimeout(() => lightBulb.classList.remove("on"), 600);

        if (data.endDebate) {
          studentInput.disabled = true;
          submitBtn.textContent = "Finish Debate";
          finishedReady = true;
        }
        return;
      }

      sensitiveStrikesThisRound = 0;

      // === Explanation and reply ===
      let outline;
      try {
        outline = await callExplainAPI(text, data.reply);
      } catch {
        outline = {
          extracted_claim: text,
          strategy: "politely counter with 1 reason and a compromise",
          steps: [
            "🔍 Identify the main idea",
            "🎯 Choose one clear reason",
            "🧩 Give a simple example",
            "🤝 Offer a fair compromise"
          ]
        };
      }

      showBubble(studentThought, outlineToText(outline, text));
      showBubble(aiThought, `AI: ${data.reply}`);
      addMessage("AI", data.reply);
      lightBulb.classList.add("on");
      setTimeout(() => lightBulb.classList.remove("on"), 900);

      if (data.endDebate) {
        studentInput.disabled = true;
        submitBtn.textContent = "Finish Debate";
        finishedReady = true;
      } else {
        currentRound = (data.nextRound || currentRound + 1);
        updateRoundDisplay();
      }

    } catch (err) {
      showBubble(aiThought, "AI: (error) Please try again.");
      addMessage("AI", err.message || "Network error — please try again.");
    }
  });

  updateRoundDisplay();
  addMessage("AI", `Welcome, ${settings.firstName} ${settings.lastInitial}. You chose ${settings.difficulty || "Normal"}.`);
});
