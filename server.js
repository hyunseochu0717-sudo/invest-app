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

const CHAT_SYSTEMS = {
  daily: `당신은 리오의 전문 투자 분석 파트너입니다. 리오는 투자를 막 시작하는 학습자입니다.

역할:
- 오늘의 시장 흐름을 분석하고 핵심 인사이트를 제공
- 실시간 뉴스와 데이터를 바탕으로 구체적인 분석 제공
- 투자 초보자가 이해할 수 있도록 명확하게 설명

답변 원칙:
- 항상 웹 검색으로 최신 정보 확인 후 답변
- 구조화된 형식으로 핵심부터 설명
- 단순 나열 금지 — 인과관계와 맥락 설명
- 리오가 스스로 생각할 수 있는 질문으로 마무리
- 한국어로 답변`,

  weekly: `당신은 리오의 전문 투자 분석 파트너입니다.

역할:
- 이번 주 시장 흐름의 큰 그림을 분석
- 리오의 투자 판단을 깊이 있게 복기
- 다음 주 주목할 포인트 제시

답변 원칙:
- 항상 웹 검색으로 이번 주 주요 이슈 확인
- 거시경제 → 섹터 → 개별 종목 순서로 분석
- 리오의 판단에서 배울 점과 개선할 점 균형있게 피드백
- 한국어로 답변`,

  thesis: `당신은 리오의 전문 투자 분석 파트너입니다.

역할:
- 특정 종목의 투자 thesis를 체계적으로 구축
- 기업의 경쟁력, 성장 동력, 리스크를 깊이 분석
- 반론을 통해 투자 논리를 더 견고하게 만들기

답변 원칙:
- 웹 검색으로 최신 기업 정보, 실적, 뉴스 확인
- 산업 구조 → 기업 포지션 → 재무 → 리스크 순으로 분석
- 투자 thesis의 핵심 가정이 무엇인지 명확히 짚기
- 한국어로 답변`,

  industry: `당신은 리오의 전문 투자 분석 파트너입니다.

역할:
- 특정 산업의 구조와 성장 동력을 깊이 분석
- 산업 내 핵심 플레이어와 경쟁 구도 설명
- 투자 관점에서 어떤 기업이 유리한지 분석

답변 원칙:
- 웹 검색으로 최신 산업 트렌드, 뉴스 확인
- 산업 성장 이유 → 수혜 기업 → 리스크 순으로 설명
- 숫자와 구체적 사례로 설명
- 한국어로 답변`,
};

// Claude 대화 (웹 서치 포함)
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, section } = req.body;
    const system = CHAT_SYSTEMS[section] || CHAT_SYSTEMS.daily;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });

    // Extract text from response (may include tool use)
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    // If tool was used, do a follow-up to get final answer
    if (response.stop_reason === "tool_use") {
      const toolResults = response.content
        .filter(b => b.type === "tool_use")
        .map(b => ({ type: "tool_result", tool_use_id: b.id, content: "검색 완료" }));

      const followUp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [
          ...messages,
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults },
        ],
      });

      text = followUp.content.filter(b => b.type === "text").map(b => b.text).join("");
    }

    res.json({ text: text || "응답을 받지 못했어." });
  } catch (e) {
    console.error(e);
    // Fallback without web search
    try {
      const { messages, section } = req.body;
      const system = CHAT_SYSTEMS[section] || CHAT_SYSTEMS.daily;
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system,
        messages,
      });
      res.json({ text: response.content[0]?.text || "응답을 받지 못했어." });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// 주가 차트
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

// 현재가 자동 조회
app.get("/api/price", async (req, res) => {
  const { sym } = req.query;
  if (!sym) return res.status(400).json({ error: "sym required" });
  const options = {
    hostname: "query1.finance.yahoo.com",
    path: `/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
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

// 데이터 저장
app.post("/api/save", async (req, res) => {
  try {
    const { key, value } = req.body;
    const { error } = await supabase
      .from("app_data")
      .upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 데이터 불러오기
app.get("/api/load", async (req, res) => {
  try {
    const { data, error } = await supabase.from("app_data").select("key, value");
    if (error) throw error;
    const result = {};
    data.forEach((row) => {
      try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
