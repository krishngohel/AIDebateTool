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

// IMPORTANT: disable auto-serving index.html
app.use(express.static(publicDir, { index: false }));

// Explicit page routes (no cache so you see updates)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'welcome.html'));
});

app.get('/debate', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ===== API =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function countWords(t){ return t.trim().split(/\s+/).filter(Boolean).length; }

app.post('/api/debate', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });
    if (countWords(message) > 90) return res.status(400).json({ error: 'Please keep under 90 words' });

    const systemPrompt = `
You are "DebateBot", a friendly and respectful debater for middle school students.
Provide short, kind counterpoints with one clear reason (under 120 words).
Always use age-appropriate, educational language.
`;

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: `${systemPrompt}\n\nStudent said:\n"${message}"\n\nDebateBot reply:`
    });

    res.json({ reply: response.output_text?.trim() || 'Hmm, I need more time to think.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get AI response.' });
  }
});
// --- Add after /api/debate ---
app.post('/api/explain', async (req, res) => {
  try {
    const { student, reply } = req.body;
    if (!student || !reply) return res.status(400).json({ error: 'Missing student or reply' });

    const prompt = `
You are writing a SHORT, kid-friendly "thinking outline" that explains how the AI formed its reply.
Rules:
- 3 to 5 bullet points, each max ~14 words.
- Use simple language and 1 emoji per bullet.
- Do NOT reveal hidden chain-of-thought; keep it high-level (plan/strategy).
- Output ONLY JSON with this shape:
{
  "extracted_claim": "string",
  "stance": "agree" | "disagree" | "mixed",
  "strategy": "string",
  "steps": ["point 1", "point 2", "point 3"]
}

Student said: """${student}"""
AI reply: """${reply}"""
Return JSON only.
`;

    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
    });

    const text = (r.output_text || "").trim();
    let json;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      json = {
        extracted_claim: student.slice(0, 140),
        stance: "mixed",
        strategy: "offer a polite counterpoint and a compromise",
        steps: [
          "🔍 Identify the main idea",
          "🎯 Pick one clear reason",
          "🧩 Give a simple example",
          "🤝 Offer a fair compromise"
        ]
      };
    }
    if (!Array.isArray(json.steps) || !json.steps.length) {
      json.steps = [
        "🔍 Identify the main idea",
        "🎯 Pick one clear reason",
        "🧩 Give a simple example",
        "🤝 Offer a fair compromise"
      ];
    }
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build explanation.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
