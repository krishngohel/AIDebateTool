// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple helper for word counting
function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

app.post('/api/debate', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }

    if (countWords(message) > 90) {
      return res.status(400).json({ error: 'Please keep under 90 words' });
    }

    const systemPrompt = `
You are "DebateBot", a friendly and respectful debater for middle school students.
Provide short, kind counterpoints with one clear reason (under 120 words).
Always use age-appropriate, educational language.
`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `${systemPrompt}\n\nStudent said:\n"${message}"\n\nDebateBot reply:`
    });

    const reply = response.output_text?.trim() || "Hmm, I need more time to think.";

    res.json({ reply });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to get AI response.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
