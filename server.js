// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import profaneWords from 'profane-words';   // ⬅️ NEW: profanity wordlist

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const SESSION_DIR = path.join(__dirname, 'data', 'sessions');

// --- Helper to sanitize strings for filenames ---
function safeName(str) {
  return str
    ?.toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 24) || "anon";
}

// --- Helper to build readable filenames ---
function makeSessionBase(student, settings) {
  const date = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
  const name = safeName(`${student.first_name || "Anon"}${student.last_initial || ""}`);

  // Accept "6","7","8" OR any custom text
  const raw = (student.grade ?? "X").toString().trim();
  let gradeLabel;
  if (["6", "7", "8"].includes(raw)) {
    gradeLabel = `G${raw}`;
  } else {
    gradeLabel = safeName(raw.length ? raw : "Other");
  }

  const topic = safeName((settings.topic || "Topic").toString());
  return `${gradeLabel}_${name}_${topic}_${date}`;
}

// Ensure session folder exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const sensitiveCounts = new Map();
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

/* -------------------------- Readability helpers -------------------------- */
function countSyllables(word) {
  word = (word || '').toLowerCase().replace(/e\b/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}
function readabilityGrade(text) {
  const words = (text || '').match(/\b[\w']+\b/g) || [];
  const sentences = (text || '').split(/[.!?]/).filter(s => s.trim().length > 0);
  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  if (words.length === 0 || sentences.length === 0) return 0;
  const grade = 0.39 * (words.length / sentences.length)
              + 11.8 * (syllables / words.length)
              - 15.59;
  return +grade.toFixed(2);
}

/* ----------------------------- Session APIs ------------------------------ */
app.post('/api/session/start', (req, res) => {
  const { first_name, last_initial, grade, difficulty, topic, side } = req.body || {};
  const baseName = makeSessionBase({ first_name, last_initial, grade }, { topic });
  const randomTag = crypto.randomBytes(2).toString('hex');
  const session_id = `${baseName}_${randomTag}`;
  const start_ts = new Date().toISOString();
  const base = path.join(SESSION_DIR, session_id);

  const sessionJson = {
    session_id,
    start_ts,
    student: { first_name, last_initial, grade },
    settings: { difficulty, topic, side }, // store student’s chosen side
    turns: []
  };

  fs.writeFileSync(`${base}.json`, JSON.stringify(sessionJson, null, 2));
  fs.writeFileSync(
    `${base}.csv`,
    'round,student_text,ai_reply_text,student_word_count,readability_grade,hud_meter,hud_leader,latency_ms,status,category\n'
  );

  res.json({ session_id, start_ts });
});

app.post('/api/session/logTurn', (req, res) => {
  const {
    session_id, round,
    student_text, ai_reply_text,
    hud_meter, hud_leader,
    latency_ms,
    status = "ok",
    category = ""
  } = req.body || {};

  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  const base = path.join(SESSION_DIR, session_id);
  const jsonPath = `${base}.json`;
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Session not found' });

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const wc = (student_text?.match(/\b[\w']+\b/g) || []).length;
  const grade = readabilityGrade(student_text || '');

  const turn = {
    round,
    student_text,
    ai_reply_text,
    student_word_count: wc,
    readability_grade: grade,
    hud_meter,
    hud_leader,
    latency_ms,
    status,
    category
  };
  data.turns.push(turn);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

  const esc = (s='') => s.replace(/"/g, '""');
  const line =
    `${round},"${esc(student_text)}","${esc(ai_reply_text)}",${wc},${grade},${hud_meter ?? ''},${hud_leader ?? ''},${latency_ms ?? ''},${status},${category}\n`;
  fs.appendFileSync(`${base}.csv`, line);

  res.json({ ok: true });
});

app.post('/api/session/finish', (req, res) => {
  const { session_id, winner_final, violations_total = 0, hud_avg = null, hud_last = null } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const base = path.join(SESSION_DIR, session_id);
  const jsonPath = `${base}.json`;
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Session not found' });

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  data.end_ts = new Date().toISOString();

  const grades = data.turns.map(t => t.readability_grade).filter(n => typeof n === 'number');
  const avgGrade = grades.length ? +(grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(2) : 0;

  data.summary = {
    rounds_played: data.turns.length,
    winner_final,
    avg_hud_meter: hud_avg,
    last_hud_meter: hud_last,
    violations_total,
    readability_avg_grade: avgGrade
  };

  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  fs.appendFileSync(
    `${base}.csv`,
    `\nSummary,,,,avg_readability,avg_hud,last_hud,winner\n,,,,${avgGrade},${hud_avg ?? ''},${hud_last ?? ''},${winner_final || ''}\n`
  );

  res.json({ ok: true });
});

/* --------------------------- Soft on-topic helpers ----------------------- */
const TOPIC_KEYWORDS = {
  "Video games can help learning": [
    "video game","gaming","game","learn","learning","educational","practice","skills",
    "strategy","puzzle","problem solving","memory","hand eye coordination","minecraft","fortnite","roblox"
  ],
  "Homework should be optional": [
    "homework","assignment","study","after school","optional","practice","workload","busywork",
    "stress","stressed","tired","drained","overwhelmed","relax","free time","time at home","worksheet","due"
  ],
  "School should start later": [
    "start time","start later","sleep","tired","morning","bell schedule","wake up","too early","rest","fatigue","bus schedule"
  ],
  "School uniforms are a good idea": [
    "uniform","dress code","clothes","bullying","equal","equality","cost","same outfit","appearance","brand","fashion","fairness"
  ],
  "Zoos are helpful for animals": [
    "zoo","animal","habitat","conservation","rescue","species","extinct","breeding","sanctuary","care","keepers","protection"
  ]
};
function keywordMatch(topic, text) {
  const list = TOPIC_KEYWORDS[topic] || [];
  const lower = (text || '').toLowerCase();
  return list.some(k => lower.includes(k));
}

/* ------------------- Word-limit & minimal moderation -------------------- */
const WORD_LIMITS = {
  Beginner: 90,
  Intermediate: 90,
  Normal: 90,
  Hard: 130,
  Extreme: 200,
};
function wordCount(s = "") {
  return (s.match(/\b[\w']+\b/g) || []).length;
}

/* ------------------- Profanity list integration ------------------------- */

// Build a Set from the profane-words package for fast lookup
const RAW_PROFANE = Array.isArray(profaneWords)
  ? profaneWords
  : (Array.isArray(profaneWords?.default) ? profaneWords.default : []);

const PROFANE_SET = new Set(
  RAW_PROFANE.map(w => w.toLowerCase())
);

// Helper: check if a message contains any profane word from the list
function containsProfanity(message = "") {
  const lower = message.toLowerCase();
  const tokens = lower.match(/\b[\w']+\b/g) || [];
  return tokens.some(t => PROFANE_SET.has(t));
}

// VERY strong content: explicit sexual + self-harm
const HARD_BAN = /\b(rape|porn|pornography|xxx|onlyfans|nude|naked|sexual\s+act|suicide|kill yourself|self[-\s]?harm)\b/i;

// Strong language, slurs, explicit solo sexual acts, etc.
const LANGUAGE_BAN = /\b(fuck(?:ing|er|s)?|shit(?:ty)?|bitch(?:es)?|asshole|bastards?|dick(?:head)?|pussy|masturbat(?:e|ing|ion)|jerk(?:ing)?\s*off|cocksucker|whore|slut|nigga|nigger|beaner|faggot|fag|faggetry|ass)\b/i;


/* ------------------------------ Debate API ------------------------------- */

app.post('/api/debate', async (req, res) => {
  try {
    const {
      message,
      difficulty = "Normal",
      round = 1,
      topic = null,
      studentSide = null,         // student's chosen side ('pro' or 'con')
      studentInfo = {}
    } = req.body;

    if (!message) return res.status(400).json({ error: 'Missing message' });

    const studentKey = `${studentInfo.firstName || "unknown"}_${studentInfo.lastInitial || ""}`;
    const wc = wordCount(message || "");   // ✅ use word count for short-answer penalty

    // 1) Manual filtering: very strong content vs strong language
    let violationType = null;

    if (HARD_BAN.test(message)) {
      violationType = "hard";
    } else if (LANGUAGE_BAN.test(message)) {
      violationType = "language";
    }

    if (violationType) {
      const current = sensitiveCounts.get(studentKey) || 0;
      const next = current + 1;
      sensitiveCounts.set(studentKey, next);

      const isHard = violationType === "hard";

      const firstMsg = isHard
        ? "Please avoid graphic self-harm or explicit sexual content. Let's keep this school-safe."
        : "Please avoid strong curse words or slurs. Let's keep the debate respectful and school-safe.";

      const stopMsg = "We have to stop the debate now to keep things school-appropriate.";

      if (next >= 3) {
        return res.json({
          violation: true,
          category: "sensitive",
          endDebate: true,
          allowRetry: false,
          instructions: stopMsg
        });
      }

      return res.json({
        violation: true,
        category: "sensitive",
        allowRetry: true,
        instructions: firstMsg
      });
    } else {
      // If previous violations exist but message is now clean, reset count
      if (sensitiveCounts.get(studentKey)) sensitiveCounts.set(studentKey, 0);
    }

    // 2) VERY soft on-topic nudge (never blocks)
    let hint = "";
    if (topic && !keywordMatch(topic, message)) {
      hint = `Let’s try to mention the topic “${topic}” directly or a related idea.`;
    }

    // 3) Difficulty profiles with “pivot” guidance (less full concession as difficulty rises)
    const profiles = {
      Beginner: {
        style: `
You are a friendly teacher.
Give ONE short kind counterpoint with simple words.
Freely agree when the student is reasonable; praise effort.
Keep your reply under 70 words.`,
        bias: 0.18   // student-favoring base
      },
      Intermediate: {
        style: `
You are a polite coach.
Acknowledge strong points briefly, then add ONE gentle counterpoint or limitation.
Avoid full concession; try a new angle.
Keep your reply under 90 words.`,
        bias: 0.40   // slight student tilt
      },
      Normal: {
        style: `
You are a balanced peer.
If you agree, keep it brief, then pivot to a new angle to stay balanced.
Provide ONE clear counterpoint politely. Max 100 words.`,
        bias: 0.48   // near neutral
      },
      Hard: {
        style: `
You are a logical debater.
Briefly acknowledge, then present TWO counters or caveats from different angles.
Max 110 words.`,
        bias: 0.65
      },
      Extreme: {
        style: `
You are an expert debater.
Avoid full agreement: acknowledge crisply, then pivot with multiple well-reasoned counters.
Max 120 words.`,
        bias: 0.70
      }
    };
    const profile = profiles[difficulty] || profiles.Normal;

    // Make sure the AI argues the opposite of the student's chosen side
    let aiSide = "neutral";
    if (studentSide === "pro") aiSide = "con";
    else if (studentSide === "con") aiSide = "pro";

    // 4) Prompt (ask model for concession + student_strength too)
    const politeRules = `
General rules:
- Be respectful and age-appropriate.
- Stay on the chosen topic: ${topic || "student's choice"}.
- Encourage reflection and curiosity.
- The debate statement is: "${topic || "student's choice"}".
- The student picked side: "${studentSide || "unknown"}" on this statement.
- You must consistently defend the **${aiSide.toUpperCase()}** side of that statement
  for the whole debate, even if the student changes their mind later.
- You may briefly agree with specific points if they are fair, but do NOT switch sides overall.
`;

    const prompt = `
${politeRules}
Round ${round} of 5.
Difficulty: ${difficulty}
${profile.style}

Output ONLY JSON with these keys:
{
  "reply": "string",
  "stance": "agree"|"disagree"|"mixed",
  "outcome": "student"|"ai"|"mixed",
  "score": number,
  "concession": number,
  "student_strength": number
}

Student side: "${studentSide || "unknown"}"
AI side: "${aiSide}"
Student said: """${message}"""`;

    const r = await openai.responses.create({ model: "gpt-4o-mini", input: prompt });
    const out = (r.output_text || "").trim();
    let data;
    try {
      const s = out.indexOf("{"); const e = out.lastIndexOf("}");
      data = JSON.parse(out.slice(s, e + 1));
    } catch {
      data = {
        reply: "That's an interesting point—here’s one idea to consider on this topic.",
        stance: "mixed",
        outcome: "mixed",
        score: profile.bias,
        concession: 0.0,
        student_strength: 0.5
      };
    }

    // === DYNAMIC SCORING (argument-driven, light difficulty tilt) ===
    const clamp01 = x => Math.max(0, Math.min(1, x));
    const mix = (a,b,t)=>a*(1-t)+b*t;

    const concession  = clamp01(Number(data.concession ?? 0));
    const stuStrength = clamp01(Number(data.student_strength ?? 0.5));
    const stance      = (data.stance || "mixed").toLowerCase();

    // 1) Neutral base around 0.5 (0 → student ahead, 1 → AI ahead)
    let base = 0.5;

    if (stance === "agree") {
      base -= 0.12 * (0.6 + 0.4 * concession);
    } else if (stance === "mixed") {
      base -= 0.06 * (0.5 + 0.5 * concession);
    } else {
      base += 0.08 * (1 - concession);
    }

    // Student strength pulls toward student when high
    base += (0.5 - stuStrength) * 0.30;

    // ✅ Penalize ultra-short / low-effort responses on all but Beginner
    if (difficulty !== "Beginner") {
      if (wc <= 4) {
        // e.g., "homework bad" → strongly nudge toward AI
        base = mix(base, 0.68, 0.55);
      } else if (wc <= 8) {
        // short, weak arguments → softer nudge to AI
        base = mix(base, 0.60, 0.35);
      }
    }

    // Tiny jitter
    base += (Math.random() * 0.02 - 0.01);
    base = clamp01(base);

    function applyDifficultyTilt(baseScore, diff) {
      let target = 0.50, k = 0.00;
      switch (diff) {
        case "Beginner":
          target = 0.25; k = 0.00;  // student-friendly
          break;
        case "Intermediate":
          target = 0.40; k = 0.08;  // slight student tilt (~30% AI overall)
          break;
        case "Normal":
          target = 0.50; k = 0.05;  // ~50/50
          break;
        case "Hard":
          target = 0.60; k = 0.12;  // edge to AI
          break;
        case "Extreme":
          target = 0.75; k = 0.35;  // strong AI edge
          break;
        default:
          target = 0.50; k = 0.05;
      }
      return clamp01(mix(baseScore, target, k));
    }

    let score = applyDifficultyTilt(base, difficulty);

    // Guardrails
    if (difficulty === "Beginner") {
      const saidAnything = (message || "").trim().length > 0;
      if (saidAnything) score = Math.min(score, 0.35);  // ✅ easy mode: student clearly ahead
    } else if (difficulty === "Extreme") {
      if (stuStrength >= 0.75 && Math.random() < 0.10) {
        score = Math.min(score, 0.46); // ~10% hero wins
      }
    }

    // Outcome
    if (score > 0.52) data.outcome = "ai";
    else if (score < 0.48) data.outcome = "student";
    else data.outcome = "mixed";

    // HUD
    const meter = Math.round(score * 100);
    let leader = "tied";
    if (meter > 52) leader = "ai";
    else if (meter < 48) leader = "student";

    const label = leader === "ai"
      ? (meter >= 80 ? "AI far ahead"
        : meter >= 65 ? "AI clearly ahead"
        : "AI slightly ahead")
      : leader === "student"
        ? (meter <= 20 ? "Student far ahead"
          : meter <= 35 ? "Student clearly ahead"
          : "Student slightly ahead")
        : "Neck and neck";

    data.score     = score;
    data.round     = round;
    data.nextRound = round + 1;
    data.endDebate = data.nextRound > 5;
    if (!data.reply) {
      data.reply = "Thanks! I see your point—here’s one idea to consider on this topic.";
    }
    data.hud = { meter, leader, label, difficulty };
    if (hint) data.hint = hint;

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error:"Failed to get AI response." });
  }
});

/* ------------------------------- Start server ---------------------------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server running → http://localhost:${PORT}`));
