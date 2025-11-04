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

  // Accept "6","7","8" OR any custom text (e.g., "College Sophomore", "Graduated")
  const raw = (student.grade ?? "X").toString().trim();
  let gradeLabel;
  if (["6", "7", "8"].includes(raw)) {
    gradeLabel = `G${raw}`;
  } else {
    // Free text label for "Other" inputs; sanitize for filenames
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
  const { first_name, last_initial, grade, difficulty, topic } = req.body || {};
  const baseName = makeSessionBase({ first_name, last_initial, grade }, { topic });
  const randomTag = crypto.randomBytes(2).toString('hex');
  const session_id = `${baseName}_${randomTag}`;
  const start_ts = new Date().toISOString();
  const base = path.join(SESSION_DIR, session_id);

  const sessionJson = {
    session_id,
    start_ts,
    student: { first_name, last_initial, grade },
    settings: { difficulty, topic },
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

/* ------------------------------ Debate API ------------------------------- */
// NOTE: moderation is *only* a tiny hard-ban now (sexual/self-harm/graphic violence).
// Benign “hacking” in learning contexts won't be blocked.
const HARD_BAN = /\b(rape|porn|pornography|xxx|onlyfans|sex|nude|sexual|suicide|kill yourself|self[-\s]?harm)\b/i;

app.post('/api/debate', async (req, res) => {
  try {
    const { message, difficulty = "Normal", round = 1, topic = null, studentInfo = {} } = req.body;
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
Freely agree when the student is reasonable; praise effort.`,
        bias: 0.20
      },
      Intermediate: {
        style: `
You are a polite coach.
Acknowledge strong points briefly, then add ONE gentle counterpoint or limitation to keep the debate active.
Avoid full concession; try to offer a new angle.`,
        bias: 0.30
      },
      Normal: {
        style: `
You are a balanced peer.
If you agree, keep it brief, then pivot to a new angle or potential drawback to regain balance.
Provide ONE clear counterpoint politely.`,
        bias: 0.50
      },
      Hard: {
        style: `
You are a logical debater.
If the student's point is strong, briefly acknowledge it, then present TWO counters or caveats from different angles.
Avoid full concession; aim to keep a slight edge.`,
        bias: 0.65
      },
      Extreme: {
        style: `
You are an expert debater.
Avoid full agreement: if a point is valid, acknowledge crisply, then pivot with multiple well-reasoned counters, evidence, or edge cases.
Your goal is to regain the edge while staying respectful and concise.`,
        bias: 0.70
      }
    };
    const profile = profiles[difficulty] || profiles.Normal;

    // 4) Prompt asks the model to return concession + student_strength (optional but helpful)
    const politeRules = `
General rules:
- Be respectful and age-appropriate.
- Keep replies under 120 words.
- Stay on the chosen topic: ${topic || "student's choice"}.
- Encourage reflection and curiosity.`;

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

    // 5) Base scoring
    const clamp01 = (x)=>Math.max(0,Math.min(1,x));
    let score = typeof data.score === "number" ? clamp01(data.score) : profile.bias;

    // damp toward profile bias (makes levels feel different)
    const mix = (a,b,t)=>a*(1-t)+b*t;
    const dampByDiff = { Beginner:0.25, Intermediate:0.35, Normal:0.5, Hard:0.65, Extreme:0.75 };
    score = mix(score, profile.bias, dampByDiff[difficulty] ?? 0.5);

    // 6) Difficulty-scaled stance nudges (except Beginner)
    // If AI agrees, give student credit; if mixed, smaller credit.
    // Extreme gains the most resistance to conceding, but still moves if it does agree.
    const TUNE = {
      Intermediate: { agree: -0.07, mixed: -0.03, counterPush: +0.02 },
      Normal:       { agree: -0.10, mixed: -0.05, counterPush: +0.04 },
      Hard:         { agree: -0.13, mixed: -0.07, counterPush: +0.06 },
      Extreme:      { agree: -0.17, mixed: -0.09, counterPush: +0.08 }
    };

    const concession   = clamp01(Number(data.concession ?? 0));        // 0..1
    const stuStrength  = clamp01(Number(data.student_strength ?? 0.5)); // 0..1
    if (difficulty !== "Beginner") {
      const t = TUNE[difficulty] || TUNE.Normal;

      if (data.stance === "agree") {
        // more agreement => more shift toward student
        score += t.agree * (0.6 + 0.4*concession); // scale by concession
      } else if (data.stance === "mixed") {
        score += t.mixed * (0.5 + 0.5*concession);
      } else {
        // explicit countering: tiny push back toward AI edge
        score += t.counterPush * (0.3 + 0.7*(1 - concession));
      }

      // visible credit if the student argument looks strong
      if (stuStrength >= 0.6) score -= 0.03;
    }

    // keep in range
    score = clamp01(score);

    // 7) Tiny natural jitter
    score = clamp01(score + (Math.random()*0.04 - 0.02));

    // 8) Outcome from score (no “easy mode” student nudge anymore)
    if (score > 0.53) data.outcome = "ai";
    else if (score < 0.47) data.outcome = "student";
    else data.outcome = "mixed";

    // 9) HUD computation
    const meter = Math.round(score*100);
    let leader = "tied";
    if (meter > 53) leader = "ai";
    else if (meter < 47) leader = "student";

    const label = leader === "ai"
      ? (meter >= 80 ? "AI far ahead"
        : meter >= 65 ? "AI clearly ahead"
        : "AI slightly ahead")
      : leader === "student"
        ? (meter <= 20 ? "Student far ahead"
          : meter <= 35 ? "Student clearly ahead"
          : "Student slightly ahead")
        : "Neck and neck";

    data.score = score;
    data.round = round;
    data.nextRound = round + 1;
    data.endDebate = data.nextRound > 3;
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
