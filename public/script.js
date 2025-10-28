// script.js – debate page logic (welcome popup + finish debate flow)
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

  // Rounds/state
  let currentRound = 1;
  const MAX_ROUNDS = 3;
  let finishedReady = false; // becomes true after AI's 3rd reply

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

  function showPopup() {
    popup.classList.remove("hidden");
  }

  function hidePopup() {
    popup.classList.add("hidden");
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

  async function callDebateAPI(message){
    const resp = await fetch("/api/debate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        difficulty: settings?.difficulty || "Normal",
        round: currentRound
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

  // === POPUP: Return to Welcome ===
  newAttemptBtn.addEventListener("click", () => {
    localStorage.removeItem(SETTINGS_KEY);
    window.location.href = "/"; // back to welcome page
  });

  // === WELCOME POPUP ===
  console.log("👋 Loading debate page... showing welcome popup.");

  if (welcomePopup) {
    // Always show popup immediately (even if HTML had hidden)
    welcomePopup.classList.remove("hidden");

    // Lock input until student acknowledges
    if (studentInput) studentInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;

    understoodBtn.addEventListener("click", () => {
      console.log("✅ Student clicked 'Understood' — enabling debate interface.");
      welcomePopup.classList.add("hidden");
      if (studentInput) studentInput.disabled = false;
      if (submitBtn) submitBtn.disabled = false;
      studentInput.focus();
    });
  } else {
    console.warn("⚠️ Welcome popup element not found in DOM.");
  }

  // === MAIN BUTTON HANDLER ===
  submitBtn.addEventListener("click", async () => {
    // If already finished 3 rounds -> show final popup
    if (finishedReady) {
      showPopup();
      return;
    }

    const text = (studentInput.value || "").trim();
    if (!text) return;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > behavior.maxWords) {
      alert(`Please keep your argument under ${behavior.maxWords} words for ${settings.difficulty || "Normal"}.`);
      return;
    }

    // Prevent extra rounds
    if (currentRound > MAX_ROUNDS) {
      showPopup();
      return;
    }

    // Thinking visuals
    showBubble(studentThought, `Student: ${text}`);
    showBubble(aiThought, "AI: Thinking…");
    lightBulb.classList.remove("on");

    addMessage(settings?.firstName || "Student", text);
    studentInput.value = "";

    try {
      // Get AI reply
      const data = await callDebateAPI(text);

      // Explain (outline)
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

      // Show bubbles + chat
      showBubble(studentThought, outlineToText(outline, text));
      showBubble(aiThought, `AI: ${data.reply}`);
      addMessage("AI", data.reply);

      // Blink bulb
      lightBulb.classList.add("on");
      setTimeout(() => lightBulb.classList.remove("on"), 900);

      // Update round
      currentRound = data.nextRound || (currentRound + 1);
      updateRoundDisplay();

      // After 3rd AI reply: disable input and change button text
      if (currentRound > MAX_ROUNDS) {
        studentInput.disabled = true;
        submitBtn.textContent = "Finish Debate";
        finishedReady = true; // next click shows final popup
      }

    } catch (err) {
      showBubble(aiThought, "AI: (error) Please try again.");
      addMessage("AI", err.message || "Network error — please try again.");
    }
  });

  // Initial greeting
  updateRoundDisplay();
  addMessage("AI", `Welcome, ${settings.firstName} ${settings.lastInitial}. You chose ${settings.difficulty || "Normal"}.`);
});
