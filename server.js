// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

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


/* ------------------------------ Debate API ------------------------------- */
// NOTE: moderation is *only* a tiny hard-ban now (sexual/self-harm/graphic violence).
const HARD_BAN = /\b(rape|porn|pornography|xxx|onlyfans|sex|nude|sexual|suicide|kill yourself|self[-\s]?harm)\b/i;

app.post('/api/debate', async (req, res) => {
  try {
    const {
      message,
      difficulty = "Normal",
      round = 1,
      topic = null,
      studentSide = null,         // <-- NEW: student's chosen side ('pro' or 'con')
      studentInfo = {}
    } = req.body;

    if (!message) return res.status(400).json({ error: 'Missing message' });

    const studentKey = `${studentInfo.firstName || "unknown"}_${studentInfo.lastInitial || ""}`;

    // 1) Minimal hard-ban (no generic moderation call)
    if (HARD_BAN.test(message)) {
      const current = sensitiveCounts.get(studentKey) || 0;
      const next = current + 1;
      sensitiveCounts.set(studentKey, next);
      if (next >= 2) {
        return res.json({
          violation: true,
          category: "sensitive",
          endDebate: true,
          allowRetry: false,
          instructions: "We have to stop the debate now to keep things school-appropriate."
        });
      }
      return res.json({
        violation: true,
        category: "sensitive",
        allowRetry: true,
        instructions: "Please avoid explicit sexual or self-harm content. Let's keep the discussion school-safe."
      });
    } else {
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
    bias: 0.18   // student-favoring base (unchanged)
  },
  Intermediate: {
    style: `
You are a polite coach.
Acknowledge strong points briefly, then add ONE gentle counterpoint or limitation.
Avoid full concession; try a new angle.
Keep your reply under 90 words.`,
    bias: 0.40   // ↓ was 0.30 or pulled too AI after damping; set closer to student
  },
  Normal: {
    style: `
You are a balanced peer.
If you agree, keep it brief, then pivot to a new angle to stay balanced.
Provide ONE clear counterpoint politely. Max 100 words.`,
    bias: 0.48   // ↓ was 0.50; slightly student-leaning baseline
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


    // Make sure the AI argues the opposite of the student's side
    let aiSide = "neutral";
    if (studentSide === "pro") aiSide = "con";
    else if (studentSide === "con") aiSide = "pro";

    // 4) Prompt (ask model for concession + student_strength too)
    const politeRules = `
General rules:
- Be respectful and age-appropriate.
- Stay on the chosen topic: ${topic || "student's choice"}.
- Encourage reflection and curiosity.
- Argue the **${aiSide.toUpperCase()}** side relative to the student.
`;

    const prompt = `
${politeRules}
Round ${round} of 3.
Difficulty: ${difficulty}
${profile.style}

Output ONLY JSON with these keys:
{
  "reply": "string",
  "stance": "agree"|"disagree"|"mixed",
  "outcome": "student"|"ai"|"mixed",
  "score": number,
  "concession": number,          // 0..1, how much you conceded (0 = none, 1 = fully conceded)
  "student_strength": number     // 0..1, how strong the student's argument was this turn
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

// 5) Base scoring + difficulty shaping
// --- DYNAMIC SCORING (argument-driven, light difficulty tilt) ------------
const clamp01 = x => Math.max(0, Math.min(1, x));
const mix     = (a,b,t)=>a*(1-t)+b*t;

// Read signals (with safe defaults)
const concession   = clamp01(Number(data.concession ?? 0));        // 0..1
const stuStrength  = clamp01(Number(data.student_strength ?? 0.5)); // 0..1
const stance       = (data.stance || "mixed").toLowerCase();

// 1) Build neutral, argument-driven base around 0.5
//    (0 → student ahead, 1 → AI ahead)
let base = 0.5;

// Agreement / mixed / disagreement shaping
if (stance === "agree") {
  // more concession → more shift to student
  base -= 0.12 * (0.6 + 0.4 * concession);
} else if (stance === "mixed") {
  base -= 0.06 * (0.5 + 0.5 * concession);
} else {
  // disagree → toward AI, softened if conceded
  base += 0.08 * (1 - concession);
}

// Student strength pulls toward student when high (±0.15 swing total)
base += (0.5 - stuStrength) * 0.30;

// Tiny natural jitter
base += (Math.random() * 0.02 - 0.01);

base = clamp01(base);

// 2) Apply a light difficulty tilt to hit target win tendencies
function applyDifficultyTilt(baseScore, diff) {
  // target center (>0.5 favors AI) and small pull (k)
  let target = 0.50, k = 0.00;

  switch (diff) {
    case "Beginner":
      // very student friendly
      target = 0.46; k = 0.00;  // almost neutral; guardrail below enforces win
      break;
    case "Intermediate":
      // slight nudge to STUDENT (target < 0.5)
      target = 0.48; k = 0.08;  // ~30% AI overall
      break;
    case "Normal":
      // neutral
      target = 0.50; k = 0.05;  // ~50/50
      break;
    case "Hard":
      // edge to AI
      target = 0.58; k = 0.12;  // ~60% AI overall
      break;
    case "Extreme":
      // strong AI edge
      target = 0.72; k = 0.35;  // ~90% AI overall
      break;
    default:
      target = 0.50; k = 0.05;
  }
  return clamp01(mix(baseScore, target, k));
}

let score = applyDifficultyTilt(base, difficulty);

// 3) Guardrails by difficulty
if (difficulty === "Beginner") {
  // Any non-empty student input = a student-side score
  const saidAnything = (message || "").trim().length > 0;
  if (saidAnything) score = Math.min(score, 0.35);
} else if (difficulty === "Extreme") {
  // Allow ~10% heroic upsets if student_strength is high
  if (stuStrength >= 0.75 && Math.random() < 0.10) {
    score = Math.min(score, 0.46);
  }
}

// 4) Outcome decision with a gentle tie band
if (score > 0.52) data.outcome = "ai";
else if (score < 0.48) data.outcome = "student";
else data.outcome = "mixed";

// 5) HUD
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
if (!data.reply) data.reply = "Thanks! I see your point—here’s one idea to consider on this topic.";
data.hud = { meter, leader, label, difficulty };
if (hint) data.hint = hint;

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error:"Failed to get AI response." });
  }
});


/* ------------------------------ Explain API ------------------------------ */
app.post('/api/explain', async (req, res) => {
  try {
    const { student, reply } = req.body;
    if (!student || !reply)
      return res.status(400).json({ error: 'Missing student or reply' });

    const prompt = `
Explain briefly how the AI formed its reply.
3–5 bullets, ≤14 words each, 1 emoji per bullet.
Output ONLY JSON:
{"extracted_claim":"string","stance":"agree"|"disagree"|"mixed","strategy":"string","steps":["p1","p2","p3"]}
Student:"""${student}"""
AI Reply:"""${reply}"""`;

    const r = await openai.responses.create({ model: "gpt-4o-mini", input: prompt });
    const text = (r.output_text || "").trim();
    let json;
    try {
      const s = text.indexOf("{"); const e = text.lastIndexOf("}");
      json = JSON.parse(text.slice(s, e + 1));
    } catch {
      json = {
        extracted_claim: student.slice(0, 140),
        stance: "mixed",
        strategy: "give a polite counterpoint",
        steps: ["🔍 Find idea","🎯 Give counterpoint","🧩 Add example","🤝 Suggest compromise"]
      };
    }
    if (!Array.isArray(json.steps) || !json.steps.length)
      json.steps = ["🔍 Find idea","🎯 Give counterpoint","🧩 Add example","🤝 Suggest compromise"];
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build explanation." });
  }
});

/* ------------------------------- Start server ---------------------------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server running → http://localhost:${PORT}`));
