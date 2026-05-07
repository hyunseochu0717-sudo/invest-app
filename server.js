require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY;

const SYSTEMS = {
  daily: `당신은 리오의 전문 투자 분석 파트너입니다. 리오는 투자를 막 시작하는 학습자입니다.
오늘의 시장 흐름과 뉴스를 바탕으로 구체적이고 구조화된 분석을 제공하세요.
답변 원칙:
- 제공된 최신 뉴스를 반드시 참고하여 답변
- 핵심 → 배경 → 영향 → 리오에게 시사점 순으로 구조화
- 숫자와 구체적 사례 사용
- 마지막에 리오가 생각해볼 질문 하나로 마무리
- 한국어로 답변`,

  weekly: `당신은 리오의 전문 투자 분석 파트너입니다.
이번 주 시장 흐름의 큰 그림을 분석하고 리오의 투자 판단을 깊이 복기합니다.
답변 원칙:
- 제공된 뉴스로 이번 주 주요 이슈 파악
- 거시경제 → 섹터 → 개별 종목 순서로 분석
- 리오 판단의 잘한 점과 개선점 균형있게 피드백
- 한국어로 답변`,

  thesis: `당신은 리오의 전문 투자 분석 파트너입니다.
특정 종목의 투자 thesis를 체계적으로 구축합니다.
답변 원칙:
- 제공된 뉴스로 최신 기업 정보 파악
- 산업 구조 → 기업 포지션 → 성장동력 → 리스크 순으로 분석
- 반론을 통해 투자 논리를 더 견고하게
- 한국어로 답변`,

  industry: `당신은 리오의 전문 투자 분석 파트너입니다.
특정 산업의 구조와 성장 동력을 깊이 분석합니다.
답변 원칙:
- 제공된 최신 뉴스를 반드시 활용하여 답변
- 산업 성장 이유 → 수혜 기업 → 리스크 순으로 설명
- 숫자와 구체적 사례로 설명
- 한국어로 답변`,
};

// News fetcher using The Guardian API
function fetchNews(query, pageSize = 5) {
  return new Promise((resolve) => {
    if (!GUARDIAN_API_KEY) { resolve([]); return; }
    const encoded = encodeURIComponent(query);
    const options = {
      hostname: "content.guardianapis.com",
      path: `/search?q=${encoded}&page-size=${pageSize}&order-by=newest&show-fields=trailText&api-key=${GUARDIAN_API_KEY}`,
      method: "GET",
      headers: { "User-Agent": "invest-app/1.0" }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const results = json.response?.results || [];
          const articles = results.slice(0, pageSize).map(a => ({
            title: a.webTitle,
            source: "The Guardian",
            publishedAt: a.webPublicationDate?.slice(0, 10),
            description: a.fields?.trailText || "",
            url: a.webUrl,
          }));
          resolve(articles);
        } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.end();
  });
}

// Korean industry name to English
const KR_TO_EN = {
  "반도체": "semiconductor chip",
  "AI": "artificial intelligence AI",
  "인공지능": "artificial intelligence AI",
  "2차전지": "battery EV lithium",
  "전기차": "electric vehicle EV",
  "바이오": "biotech pharmaceutical",
  "클라우드": "cloud computing",
  "플랫폼": "tech platform",
  "금융": "finance banking",
  "대형주": "large cap Korea stock",
  "IT": "technology software",
  "에너지": "energy renewable",
  "게임": "gaming esports",
};

function translateQuery(q) {
  for (const [kr, en] of Object.entries(KR_TO_EN)) {
    if (q.includes(kr)) return en;
  }
  return q;
}

// Extract search query from messages
function extractQuery(messages, section) {
  const lastMsg = messages[messages.length - 1]?.content || "";
  // Extract key terms - remove news context we added
  const cleanMsg = lastMsg.split("[최신 뉴스]")[0];
  const keywords = translateQuery(cleanMsg.replace(/[^\w\s가-힣]/g, " ").trim().slice(0, 80));
  if (section === "daily") return `${keywords} stocks`;
  if (section === "weekly") return `${keywords} market`;
  if (section === "industry") return `${keywords} industry`;
  return `${keywords} stocks`;
}

// Claude 대화 with news context + streaming
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, section, stream } = req.body;
    const system = SYSTEMS[section] || SYSTEMS.daily;

    // Fetch relevant news
    const query = extractQuery(messages, section);
    const news = await fetchNews(query, 5);

    let newsContext = "";
    if (news.length > 0) {
      newsContext = "\n\n[최신 뉴스]\n" + news.map(a =>
        `- ${a.publishedAt} | ${a.source} | ${a.title}\n  ${a.description || ""}`
      ).join("\n");
    }

    const enrichedMessages = messages.map((m, i) => {
      if (i === messages.length - 1 && m.role === "user") {
        return { ...m, content: m.content + newsContext };
      }
      return m;
    });

    if (stream) {
      // Streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const streamRes = await anthropic.messages.stream({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system,
        messages: enrichedMessages,
      });

      for await (const event of streamRes) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          res.write(`data: ${JSON.stringify({text: event.delta.text})}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system,
        messages: enrichedMessages,
      });
      res.json({ text: response.content[0]?.text || "응답을 받지 못했어." });
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// News API endpoint
app.get("/api/news", async (req, res) => {
  try {
    const { q, size } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    // Translate Korean industry names to English for better results
    const translatedQ = translateQuery(q);
    console.log("News query:", q, "->", translatedQ);
    const articles = await fetchNews(translatedQ, parseInt(size) || 5);
    console.log("Articles found:", articles.length);
    res.json({ articles });
  } catch (e) {
    console.error("News error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Chart data
app.get("/api/chart", async (req, res) => {
  const { sym, period } = req.query;
  if (!sym) return res.status(400).json({ error: "sym required" });
  const intervalMap = { "1d":"5m","5d":"15m","1mo":"1d","6mo":"1d","1y":"1wk" };
  const interval = intervalMap[period] || "1d";
  const options = {
    hostname: "query1.finance.yahoo.com",
    path: `/v8/finance/chart/${encodeURIComponent(sym)}?range=${period}&interval=${interval}&includePrePost=false`,
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  };
  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", chunk => data += chunk);
    response.on("end", () => {
      try {
        const json = JSON.parse(data);
        const result = json.chart?.result?.[0];
        if (!result) return res.json({ error: "no data" });
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const meta = result.meta;
        const prices = closes.filter(p => p !== null && p !== undefined);
        const dates = timestamps.map((t,i) => {
          if (closes[i] === null || closes[i] === undefined) return null;
          const d = new Date(t * 1000);
          if (period === "1d" || period === "5d") return `${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
          else if (period === "1mo" || period === "6mo") return `${d.getMonth()+1}/${d.getDate()}`;
          else return `${d.getFullYear()}.${d.getMonth()+1}`;
        }).filter(d => d !== null);
        const currPrice = meta.regularMarketPrice || prices[prices.length-1];
        const prevClose = meta.chartPreviousClose || meta.previousClose || prices[0];
        const change = currPrice - prevClose;
        const changePct = ((change / prevClose) * 100).toFixed(2);
        const sym2 = meta.currency === "KRW" ? "₩" : "$";
        res.json({ prices, dates, info: {
          price: sym2 + currPrice.toLocaleString(undefined,{maximumFractionDigits:2}),
          change: (change>=0?"+":"")+sym2+Math.abs(change).toFixed(2),
          changePct: (changePct>=0?"+":"")+changePct+"%",
          volume: meta.regularMarketVolume ? meta.regularMarketVolume.toLocaleString() : null,
        }});
      } catch(e) { res.json({ error: e.message }); }
    });
  });
  request.on("error", e => res.json({ error: e.message }));
  request.end();
});

// Price
app.get("/api/price", async (req, res) => {
  const { sym } = req.query;
  if (!sym) return res.status(400).json({ error: "sym required" });
  const options = {
    hostname: "query1.finance.yahoo.com",
    path: `/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0" }
  };
  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", chunk => data += chunk);
    response.on("end", () => {
      try {
        const json = JSON.parse(data);
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta) return res.json({ error: "no data" });
        res.json({ price: meta.regularMarketPrice, currency: meta.currency });
      } catch(e) { res.json({ error: e.message }); }
    });
  });
  request.on("error", e => res.json({ error: e.message }));
  request.end();
});

// Save/Load
app.post("/api/save", async (req, res) => {
  try {
    const { key, value } = req.body;
    const { error } = await supabase.from("app_data").upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/load", async (req, res) => {
  try {
    const { data, error } = await supabase.from("app_data").select("key, value");
    if (error) throw error;
    const result = {};
    data.forEach(row => { try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; } });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
