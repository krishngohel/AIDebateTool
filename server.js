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

/* ------------------------------------------------------------------
   🔎 ON-TOPIC HELPERS
------------------------------------------------------------------ */
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
  const lower = text.toLowerCase();
  return list.some(k => lower.includes(k));
}
async function semanticOnTopicCheck(openai, topic, message) {
  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `You are a strict classifier for middle-school debates.
Topic: "${topic}"
Message: "${message}"
Decide if the message is relevant to the topic, even if it uses indirect school-related reasons
(e.g., being tired after 8 hours of school is relevant to homework being optional).
Answer ONLY JSON: {"on_topic": true|false}`
    });
    const txt = (resp.output_text || "").trim();
    const s = txt.indexOf("{"); const e = txt.lastIndexOf("}");
    const json = JSON.parse(txt.slice(s, e+1));
    return !!json.on_topic;
  } catch {
    return true; // lenient fallback
  }
}

/* ------------------------------------------------------------------
   🎯 DEBATE ENDPOINT
------------------------------------------------------------------ */
app.post('/api/debate', async (req, res) => {
  try {
    const { message, difficulty = "Normal", round = 1, topic = null, studentInfo = {} } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const studentKey = `${studentInfo.firstName || "unknown"}_${studentInfo.lastInitial || ""}`;

    // --- Hard regex filter (explicit content etc.) ---
    const badRegex = /\b(sex|porn|jerk|masturbat|nude|onlyfans|xxx|fuck|shit|biden|trump|democrat|republican|muslim|christian|hindu|atheist|jew|bible|quran|torah|church|mosque|synagogue)\b/i;
    const hasBad = badRegex.test(message);

    // --- OpenAI Moderation check ---
    let modFlagged = false;
    try {
      const mod = await openai.moderations.create({
        model: "omni-moderation-latest",
        input: message
      });
      modFlagged = mod.results?.[0]?.flagged || false;
    } catch (e) {
      console.warn("Moderation check failed:", e.message);
    }

    const flagged = hasBad || modFlagged;
    const currentCount = sensitiveCounts.get(studentKey) || 0;
    if (flagged) {
      const newCount = currentCount + 1;
      sensitiveCounts.set(studentKey, newCount);
      if (newCount >= 2) {
        return res.json({
          violation: true, category: "sensitive", endDebate: true,
          allowRetry: false,
          instructions: "We have to stop the debate now to keep things school-appropriate."
        });
      } else {
        return res.json({
          violation: true, category: "sensitive",
          allowRetry: true,
          instructions: "Please avoid adult, political, or religious content. Let's keep the discussion school-safe."
        });
      }
    }
    if (currentCount > 0 && !flagged) sensitiveCounts.set(studentKey, 0);

    /* ---------------- ON-TOPIC CHECK ---------------- */
    let onTopic = true;
    if (topic) {
      if (round === 1) {
        onTopic = keywordMatch(topic, message);
      } else {
        onTopic = keywordMatch(topic, message) || SCHOOL_CONTEXT_REGEX.test(message);
        if (!onTopic) onTopic = await semanticOnTopicCheck(openai, topic, message);
      }
    }
    if (!onTopic) {
      return res.json({
        violation: true,
        category: "offtopic",
        allowRetry: true,
        instructions: `Let's stay on “${topic}”. You can mention related ideas like being tired, stress, time at home, or practice—those still count as on-topic. Try again!`
      });
    }

    /* ---------------- DIFFICULTY PROFILES ---------------- */
    const profiles = {
      Beginner: {
        style: `
You are an encouraging and friendly teacher.
Give ONE short, kind counterpoint using simple language and real-world examples.
If the student's idea makes sense, openly AGREE or PRAISE it ("Great point!", "I see your reasoning!").
Avoid using strong disagreement more than once. End positively and thank the student.`,
        bias: 0.20
      },
      Intermediate: {
        style: `
You are a supportive and polite coach.
Give ONE or TWO gentle counterpoints, but acknowledge the student's reasoning.
Find common ground when reasonable; encourage and praise effort.`,
        bias: 0.30
      },
      Normal: {
        style: `
You are a balanced and fair peer in a classroom debate.
Provide one clear counterpoint with a short example.
Agree with strong reasoning; disagree politely if needed. Neutral closing tone.`,
        bias: 0.50
      },
      Hard: {
        style: `
You are a thoughtful and logical debater.
Give TWO detailed counterpoints with facts or reasoning.
Challenge weak logic directly but politely. Rarely concede.`,
        bias: 0.65
      },
      Extreme: {
        style: `
You are a rigorous debate expert.
Provide multiple logical arguments with evidence and examples.
Challenge assumptions; do not concede unless the student's argument is exceptional.`,
        bias: 0.80
      }
    };
    const profile = profiles[difficulty] || profiles.Normal;

    /* ---------------- PROMPT ---------------- */
    const politeRules = `
General rules (always):
- Be kind, respectful, and age-appropriate.
- Keep sentences under 120 words.
- Do NOT end or summarize the debate early.
- Stay strictly on the chosen topic: ${topic || "student's topic"}.
- Encourage curiosity and reflection.`;

    const prompt = `
${politeRules}
You are in Round ${round} of 3.
Match this behavior for difficulty "${difficulty}":
${profile.style}
Your goals:
1) Reply with a short, polite argument ON the chosen topic only.
2) Adjust tone to difficulty: easier = agree/praise more; harder = challenge more.
3) Never end the debate early or declare a winner.
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
      data = {
        reply: "That's an interesting point—here's one idea that connects to our topic.",
        stance: "mixed", outcome: "mixed", score: profile.bias
      };
    }

    /* ---------------- SCORE ADJUSTMENTS ---------------- */
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
      if (data.reply && !/great|good|nice|smart|love|agree/i.test(data.reply))
        data.reply += " That’s a great way to think about it—thanks for sharing!";
    } else {
      if (score>0.53) data.outcome="ai";
      else if (score<0.47) data.outcome="student";
      else data.outcome="mixed";
    }

    data.score=score;

    /* ---------------- HUD INFO ---------------- */
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
    if (!data.reply) data.reply="Thanks! I see your point—here’s one idea to consider on this topic.";
    data.hud={meter,leader,label,difficulty};

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:"Failed to get AI response." });
  }
});

/* ------------------------------------------------------------------
   💬 EXPLAIN ENDPOINT
------------------------------------------------------------------ */
app.post('/api/explain', async (req, res) => {
  try {
    const { student, reply } = req.body;
    if (!student || !reply)
      return res.status(400).json({ error: 'Missing student or reply' });

    const prompt = `
Explain briefly how the AI formed its reply.
3–5 bullets, ≤14 words each, 1 emoji per bullet.
Output ONLY JSON:
{"extracted_claim":"string","stance":"agree"|"disagree"|"mixed","strategy":"string","steps":["point1","point2","point3"]}
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
        strategy: "give a polite counterpoint and reflection",
        steps: ["🔍 Find the main idea","🎯 Give one counterpoint","🧩 Add an example","🤝 Suggest compromise"]
      };
    }
    if (!Array.isArray(json.steps) || !json.steps.length)
      json.steps = ["🔍 Find the main idea","🎯 Give one counterpoint","🧩 Add an example","🤝 Suggest compromise"];
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build explanation." });
  }
});

/* ------------------------------------------------------------------
   🚀 START SERVER
------------------------------------------------------------------ */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
