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
  lightBulb.classList.remove("on", "spark");

  // Turn on the bulb once — steady glow throughout thinking
  setTimeout(() => lightBulb.classList.add("on"), 300);

  aiThoughtSteps.forEach((step, index) => {
    const baseDelay = 600 + index * 900;

    setTimeout(() => {
      aiThought.textContent = "💭 " + step;
      aiThought.classList.add("show");

      // Add a brief spark flicker per thought, no re-removing 'on'
      lightBulb.classList.add("spark");
      setTimeout(() => lightBulb.classList.remove("spark"), 700);
    }, baseDelay);
  });
}


  // Updated to ensure AI gives a debate-style opposing reply
  async function fetchDebateReply(message) {
    const debatePrompt = `
      You are participating in a structured academic debate.
      The student says: "${message}"
      Your role is to respond with a clear and logical counterargument.
      Directly oppose or support (support after a few rounds IF their arugment is logical and supported by proper evidence and all other reasoning) their point using critical reasoning, evidence, or logic.
      Be concise (2–4 sentences max), persuasive, and respectful. note this is structured to younger k-12 students.
    `;

    const resp = await fetch('/api/debate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: debatePrompt })
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

    // Enforce the 90-word cap in the UI
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
