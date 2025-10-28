// script.js – debate page logic
document.addEventListener("DOMContentLoaded", () => {
  const SETTINGS_KEY = "debate_user_settings_v1";

  // Guard: if settings missing, go to welcome
  let settings = null;
  try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch {}
  if (!settings) { window.location.replace("/"); return; }

  // Elements
  const chatBox        = document.getElementById("chatBox");
  const studentInput   = document.getElementById("studentInput");
  const submitBtn      = document.getElementById("submitBtn");
  const studentThought = document.getElementById("studentThought"); // top bubble
  const aiThought      = document.getElementById("aiThought");      // bottom bubble
  const lightBulb      = document.getElementById("lightBulb");

  // Helpers
  function addMessage(sender, text) {
    const div = document.createElement("div");
    div.className = `chat-message ${sender === "AI" ? "ai" : "student"}`;
    div.innerHTML = `<strong>${sender}:</strong> ${text}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // Show a bubble (handles your CSS animation by adding .show)
  function showBubble(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");   // <-- IMPORTANT: makes it visible
  }

  function mapDifficultyToBehavior(diff){
    switch (diff) {
      case "Beginner":     return { maxWords: 60 };
      case "Intermediate": return { maxWords: 80 };
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
      body: JSON.stringify({ message })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "API error");
    return data.reply || "";
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

  submitBtn?.addEventListener("click", async () => {
    const text = (studentInput.value || "").trim();
    if (!text) return;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > behavior.maxWords) {
      alert(`Please keep your argument under ${behavior.maxWords} words for ${settings.difficulty || "Normal"}.`);
      return;
    }

    // Immediately show student's claim and "Thinking…" UI
    showBubble(studentThought, `Student: ${text}`);
    showBubble(aiThought, "AI: Thinking…");
    lightBulb.classList.remove("on");

    addMessage(settings?.firstName || "Student", text);
    studentInput.value = "";

    try {
      const reply = await callDebateAPI(text);

      // Try to get a short post-hoc outline; if it fails, fallback
      let outline;
      try {
        outline = await callExplainAPI(text, reply);
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

      // Top bubble = outline, bottom bubble = final reply
      showBubble(studentThought, outlineToText(outline, text));
      showBubble(aiThought, `AI: ${reply}`);
      addMessage("AI", reply);

      // Lightbulb blink
      lightBulb.classList.add("on");
      setTimeout(() => lightBulb.classList.remove("on"), 900);

    } catch (err) {
      showBubble(aiThought, "AI: (error) Please try again.");
      addMessage("AI", err.message || "Network error — please try again.");
    }
  });

  // Friendly greeting in the chat
  addMessage("AI", `Welcome back, ${settings.firstName} ${settings.lastInitial}. You chose ${settings.difficulty || "Normal"}.`);
});
