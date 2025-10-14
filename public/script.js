// script.js
document.addEventListener("DOMContentLoaded", () => {
  const chatBox = document.getElementById("chatBox");
  const studentInput = document.getElementById("studentInput");
  const submitBtn = document.getElementById("submitBtn");
  const studentThought = document.getElementById("studentThought");
  const aiThought = document.getElementById("aiThought");
  const lightBulb = document.getElementById("lightBulb");

  function addMessage(sender, text) {
    const msg = document.createElement("div");
    msg.classList.add("chat-message");
    msg.innerHTML = `<strong>${sender}:</strong> ${text}`;
    chatBox.appendChild(msg);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  const aiThoughtSteps = [
    "Hmmm 🤔 let me think...",
    "Analyzing your point 💭",
    "Because of that, maybe this makes sense...",
    "Interesting! Let's see..."
  ];

  function animateAIThoughts(studentText) {
    studentThought.textContent = "💭 " + studentText;
    studentThought.classList.add("show");

    aiThought.classList.remove("show");
    lightBulb.classList.remove("on");

    aiThoughtSteps.forEach((step, index) => {
      setTimeout(() => {
        lightBulb.classList.add("on");
        aiThought.textContent = "💭 " + step;
        aiThought.classList.add("show");
      }, 600 + index * 900);
    });
  }

  async function fetchDebateReply(message) {
    const resp = await fetch('/api/debate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Request failed with ${resp.status}`);
    }
    const data = await resp.json();
    return data.reply || "I need a moment to think of a counterpoint.";
  }

  submitBtn.addEventListener("click", async () => {
    const text = studentInput.value.trim();
    if (!text) {
      alert("Please enter something!");
      return;
    }
    // Enforce the 90-word cap in the UI, too.
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 90) {
      alert(`Please keep your argument at ≤ 90 words. You used ${words.length}.`);
      return;
    }

    addMessage("Student", text);
    studentInput.value = "";

    // Start the "thinking" animation
    animateAIThoughts(text);

    try {
      const aiReply = await fetchDebateReply(text);

      // Wait until the thought animation finishes (~ aiThoughtSteps * 900 + 600)
      const finalDelay = 600 + aiThoughtSteps.length * 900 + 200;
      setTimeout(() => {
        aiThought.textContent = "🤖 " + aiReply;
        addMessage("AI", aiReply);
      }, finalDelay);
    } catch (e) {
      addMessage("AI", "Sorry, I ran into a problem reaching the debate service.");
      console.error(e);
    }
  });
});

