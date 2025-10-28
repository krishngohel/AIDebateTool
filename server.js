// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(publicDir, { index: false }));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'welcome.html'));
});

app.get('/debate', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== DEBATE ENDPOINT (3-round limit) ======
app.post('/api/debate', async (req, res) => {
  try {
    const { message, difficulty = "Normal", round = 1 } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });

    // If debate is over — return cleanly
    if (round > 3) {
      return res.json({
        reply: "",
        stance: "mixed",
        outcome: "student",
        score: 0.4,
        round,
        nextRound: round,
        endDebate: true
      });
    }

    const politeRules = `
General rules (always):
- Always be kind, respectful, and age-appropriate.
- Use short, clear sentences (≤120 words).
- Do NOT end or summarize the debate unless explicitly told to.
- Encourage curiosity and reflection.
`;

    // Difficulty profiles
    const profiles = {
      Beginner: {
        style: `
Gentle, supportive coach. Offer 1 kind counterpoint with familiar examples.
Concede easily when student sounds reasonable.
`,
        bias: 0.35
      },
      Intermediate: {
        style: `
Helpful and fair. Give 1–2 clear counterpoints and sometimes agree.
`,
        bias: 0.45
      },
      Normal: {
        style: `
Balanced and logical. Provide 1 clear counterpoint with example; concede only for strong reasoning.
`,
        bias: 0.5
      },
      Hard: {
        style: `
Analytical but kind. Address multiple aspects logically. Rarely concede.
`,
        bias: 0.6
      },
      Extreme: {
        style: `
Rigorous yet polite. Challenge assumptions logically and rarely concede.
`,
        bias: 0.7
      }
    };

    const profile = profiles[difficulty] || profiles.Normal;

    // === Updated Prompt Logic ===
    const prompt = `
${politeRules}

You are currently in **Round ${round} of 3** of a short debate.
Your job: reply with a respectful counterargument or reflection.
Do NOT end the debate, congratulate the student, or summarize — just give your next thoughtful point.
Only on round 4 or later would you end politely (not now).

Difficulty: ${difficulty}
Style:
${profile.style}

Output ONLY JSON:
{
  "reply": "string",
  "stance": "agree"|"disagree"|"mixed",
  "outcome": "student"|"ai"|"mixed",
  "score": number
}

Student said:
"""${message}"""
`;

    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt
    });

    const text = (r.output_text || "").trim();
    let data;

    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      data = {
        reply: "That's an interesting point! Here's another way to think about it.",
        stance: "mixed",
        outcome: "mixed",
        score: profile.bias
      };
    }

    // Clean and finalize response
    if (typeof data.score !== "number") data.score = profile.bias;
    data.score = Math.max(0, Math.min(1, data.score));
    if (!["student", "ai", "mixed"].includes(data.outcome)) data.outcome = "mixed";
    if (!["agree", "disagree", "mixed"].includes(data.stance)) data.stance = "mixed";
    if (!data.reply) data.reply = "Interesting point! Here's something to consider...";

    // Round tracking
    data.round = round;
    data.nextRound = round + 1;
    data.endDebate = data.nextRound > 3;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get AI response." });
  }
});

// ====== EXPLAIN ENDPOINT ======
app.post('/api/explain', async (req, res) => {
  try {
    const { student, reply } = req.body;
    if (!student || !reply)
      return res.status(400).json({ error: 'Missing student or reply' });

    const prompt = `
Explain briefly how the AI formed its reply.
3–5 bullets, ≤14 words each, 1 emoji per bullet.
Output ONLY JSON:
{
  "extracted_claim":"string",
  "stance":"agree"|"disagree"|"mixed",
  "strategy":"string",
  "steps":["point1","point2","point3"]
}

Student: """${student}"""
AI Reply: """${reply}"""
`;

    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt
    });

    const text = (r.output_text || "").trim();
    let json;
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      json = {
        extracted_claim: student.slice(0, 140),
        stance: "mixed",
        strategy: "give a polite counterpoint and reflection",
        steps: [
          "🔍 Find the main idea",
          "🎯 Give one counterpoint",
          "🧩 Add an example",
          "🤝 Suggest compromise"
        ]
      };
    }

    if (!Array.isArray(json.steps) || !json.steps.length) {
      json.steps = [
        "🔍 Find the main idea",
        "🎯 Give one counterpoint",
        "🧩 Add an example",
        "🤝 Suggest compromise"
      ];
    }

    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build explanation." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
