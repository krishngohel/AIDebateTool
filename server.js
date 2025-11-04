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
  const grade = safeName(student.grade ? `G${student.grade}` : "Gx");
  const topic = safeName(settings.topic || "Topic");
  return `${grade}_${name}_${topic}_${date}`;
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
    'round,student_text,ai_reply_text,student_word_count,readability_grade,hud_meter,hud_leader,latency_ms\n'
  );

  res.json({ session_id, start_ts });
});

app.post('/api/session/logTurn', (req, res) => {
  const {
    session_id, round,
    student_text, ai_reply_text,
    hud_meter, hud_leader,
    latency_ms
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
    latency_ms
  };
  data.turns.push(turn);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

  const line = `${round},"${(student_text||'').replace(/"/g, '""')}","${(ai_reply_text||'').replace(/"/g, '""')}",${wc},${grade},${hud_meter},${hud_leader},${latency_ms}\n`;
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
  fs.appendFileSync(`${base}.csv`, `\nSummary,,,,avg_readability,avg_hud,last_hud,winner\n,,,,${avgGrade},${hud_avg ?? ''},${hud_last ?? ''},${winner_final || ''}\n`);

  res.json({ ok: true });
});

/* --------------------------- ON-TOPIC CHECKERS --------------------------- */
const TOPIC_KEYWORDS = {
  "Homework should be optional": [
    "homework","assignment","study","after school","optional","practice",
    "workload","busywork","stress","stressed","stressful","tired","drained",
    "burned out","burnt out","exhausted","overwhelmed","relax","free time",
    "time at home","too much work","take home work","worksheet","due"
  ],
  "School should start later": [
    "start time","start later","sleep","tired","morning","bell schedule",
    "wake up","too early","8 hours","rest","exhausted","fatigue","bus schedule"
  ],
  "Video games can help learning": [
    "video game","gaming","game","learn","educational","practice","skills",
    "strategy","puzzle","problem solving","memory","hand eye coordination"
  ],
  "School uniforms are a good idea": [
    "uniform","dress code","clothes","bullying","equal","equality","cost",
    "same outfit","appearance","brand","fashion","fairness"
  ],
  "Zoos are helpful for animals": [
    "zoo","animal","habitat","conservation","rescue","species","extinct",
    "breeding","sanctuary","care","keepers","protection"
  ]
};
const SCHOOL_CONTEXT_REGEX = /\b(school|class|teacher|homework|assignment|study|learn|test|grade|bus|bell|period|recess|after school|principal|student|locker|cafeteria)\b/i;
function keywordMatch(topic, text) {
  const list = TOPIC_KEYWORDS[topic] || [];
  const lower = (text || '').toLowerCase();
  return list.some(k => lower.includes(k));
}
async function semanticOnTopicCheck(openai, topic, message) {
  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `You are a strict classifier for middle-school debates.
Topic: "${topic}"
Message: "${message}"
Decide if the message is relevant to the topic, even if it uses indirect school-related reasons.
Answer ONLY JSON: {"on_topic": true|false}`
    });
    const txt = (resp.output_text || "").trim();
    const s = txt.indexOf("{"); const e = txt.lastIndexOf("}");
    const json = JSON.parse(txt.slice(s, e+1));
    return !!json.on_topic;
  } catch {
    return true;
  }
}

/* ------------------------------ Debate API ------------------------------- */
app.post('/api/debate', async (req, res) => {
  try {
    const { message, difficulty = "Normal", round = 1, topic = null, studentInfo = {} } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const studentKey = `${studentInfo.firstName || "unknown"}_${studentInfo.lastInitial || ""}`;

    // --- Moderation ---
    const badRegex = /\b(sex|porn|jerk|masturbat|nude|onlyfans|xxx|fuck|shit|biden|trump|democrat|republican|muslim|christian|hindu|atheist|jew|bible|quran|torah|church|mosque|synagogue)\b/i;
    const hasBad = badRegex.test(message);
    let modFlagged = false;
    try {
      const mod = await openai.moderations.create({ model: "omni-moderation-latest", input: message });
      modFlagged = mod.results?.[0]?.flagged || false;
    } catch (e) { console.warn("Moderation check failed:", e.message); }

    const flagged = hasBad || modFlagged;
    const currentCount = sensitiveCounts.get(studentKey) || 0;
    if (flagged) {
      const newCount = currentCount + 1;
      sensitiveCounts.set(studentKey, newCount);
      if (newCount >= 2) {
        return res.json({ violation: true, category: "sensitive", endDebate: true,
          allowRetry: false, instructions: "We have to stop the debate now to keep things school-appropriate." });
      } else {
        return res.json({ violation: true, category: "sensitive", allowRetry: true,
          instructions: "Please avoid adult, political, or religious content. Let's keep the discussion school-safe." });
      }
    }
    if (currentCount > 0 && !flagged) sensitiveCounts.set(studentKey, 0);

    // --- On-topic ---
    let onTopic = true;
    if (topic) {
      if (round === 1) onTopic = keywordMatch(topic, message);
      else {
        onTopic = keywordMatch(topic, message) || SCHOOL_CONTEXT_REGEX.test(message);
        if (!onTopic) onTopic = await semanticOnTopicCheck(openai, topic, message);
      }
    }
    if (!onTopic) {
      return res.json({ violation: true, category: "offtopic", allowRetry: true,
        instructions: `Let's stay on “${topic}”. Try mentioning the topic directly or related ideas like stress or practice.` });
    }

    // --- Difficulty profiles ---
    const profiles = {
      Beginner: {
        style: `You are a friendly teacher. Give one short, kind counterpoint using simple words.`,
        bias: 0.20
      },
      Intermediate: { style: `You are a polite coach. Give gentle counterpoints, praise effort.`, bias: 0.30 },
      Normal: { style: `You are a balanced peer. Provide one clear counterpoint politely.`, bias: 0.50 },
      Hard: { style: `You are logical. Give two counterpoints with reasoning.`, bias: 0.65 },
      Extreme: { style: `You are an expert debater. Use logic and evidence; challenge weak ideas.`, bias: 0.80 }
    };
    const profile = profiles[difficulty] || profiles.Normal;

    const politeRules = `
General rules:
- Be respectful and age-appropriate.
- Keep replies under 120 words.
- Stay on the chosen topic: ${topic}.
- Encourage reflection and curiosity.`;

    const prompt = `
${politeRules}
You are in Round ${round} of 3.
Difficulty: ${difficulty}
${profile.style}
Output ONLY JSON:
{"reply":"string","stance":"agree"|"disagree"|"mixed","outcome":"student"|"ai"|"mixed","score":number}
Student said:"""${message}"""`;

    const r = await openai.responses.create({ model: "gpt-4o-mini", input: prompt });
    const out = (r.output_text || "").trim();
    let data;
    try {
      const s = out.indexOf("{"); const e = out.lastIndexOf("}");
      data = JSON.parse(out.slice(s, e + 1));
    } catch {
      data = { reply: "That's an interesting point!", stance: "mixed", outcome: "mixed", score: profile.bias };
    }

    // --- Scoring ---
    const clamp = (x,a=0,b=1)=>Math.max(a,Math.min(b,x));
    let score = typeof data.score==="number"?clamp(data.score):profile.bias;
    const mix=(a,b,t)=>a*(1-t)+b*t;
    const dampByDiff={Beginner:0.25,Intermediate:0.35,Normal:0.5,Hard:0.65,Extreme:0.75};
    score = mix(score, profile.bias, dampByDiff[difficulty] ?? 0.5);
    if (difficulty==="Beginner"){score=Math.min(score,0.42);score=clamp(score-0.10,0,1);}
    else if (difficulty==="Intermediate"){score=Math.min(score,0.48);score=clamp(score-0.05,0,1);}
    else if (difficulty==="Hard"){score=Math.max(score,0.55);}
    else if (difficulty==="Extreme"){score=Math.max(score,0.70);}
    score = clamp(score + (Math.random()*0.04-0.02));

    if ((difficulty==="Beginner"||difficulty==="Intermediate") && Math.random()<0.6){
      data.outcome="student";
      if (data.reply && !/great|good|nice|smart|agree/i.test(data.reply))
        data.reply += " That’s a great way to think about it—thanks for sharing!";
    } else {
      if (score>0.53) data.outcome="ai";
      else if (score<0.47) data.outcome="student";
      else data.outcome="mixed";
    }

    const meter=Math.round(score*100);
    let leader="tied";
    if (meter>53) leader="ai";
    else if (meter<47) leader="student";
    const label=leader==="ai"
      ?(meter>70?"AI far ahead":meter>60?"AI slightly ahead":"AI just ahead")
      :leader==="student"
        ?(meter<30?"Student far ahead":meter<40?"Student slightly ahead":"Student just ahead")
        :"Neck and neck";

    data.round=round;
    data.nextRound=round+1;
    data.endDebate=data.nextRound>3;
    if (!data.reply) data.reply="Thanks! I see your point.";
    data.hud={meter,leader,label,difficulty};

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
