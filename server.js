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

// Claude 대화
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, system } = req.body;
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system,
      messages,
    });
    res.json({ text: response.content[0].text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
    console.error(e);
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
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
