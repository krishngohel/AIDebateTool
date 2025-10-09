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

  // AI intermediate thinking steps
  const aiThoughtSteps = [
    "Hmmm 🤔 let me think...",
    "Analyzing your point 💭",
    "Because of that, maybe this makes sense...",
    "Interesting! Let's see..."
  ];

  // AI final responses
  const aiResponses = [
    "I see your point! However, consider this...",
    "That’s a valid idea, but another perspective is...",
    "Good argument! But also keep in mind...",
    "I agree in part, but it depends on context..."
  ];

  function animateAIThoughts(studentText) {
    // Show student cloud
    studentThought.textContent = "💭 " + studentText;
    studentThought.classList.add("show");

    aiThought.classList.remove("show");
    lightBulb.classList.remove("on");

    // Sequentially show AI thought clouds
    aiThoughtSteps.forEach((step, index) => {
      setTimeout(() => {
        lightBulb.classList.add("on");
        aiThought.textContent = "💭 " + step;
        aiThought.classList.add("show");
      }, 1000 + index * 1200); // each step delayed by 1.2s
    });

    // Show final AI response
    setTimeout(() => {
      const finalReply = aiResponses[Math.floor(Math.random() * aiResponses.length)];
      aiThought.textContent = "🤖 " + finalReply;
      addMessage("AI", finalReply);
    }, 1000 + aiThoughtSteps.length * 1200); // after last thought step
  }

  submitBtn.addEventListener("click", () => {
    const text = studentInput.value.trim();
    if (!text) {
      alert("Please enter something!");
      return;
    }
    addMessage("Student", text);
    studentInput.value = "";

    animateAIThoughts(text);
  });
});
