const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_MODEL = Deno.env.get("OPENAI_PFISTER_MODEL") || "gpt-5.4-mini";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TEST_CODE = "PFISTER_V2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const allowedCategories = [
  "tapete puro",
  "tapete desequilibrado",
  "tapete furado ou rasgado",
  "tapete com início de ordem",
  "formação em camadas",
  "formação simétrica",
  "formação alternada",
  "estrutura simétrica",
  "estrutura em escada",
  "estrutura em manto",
  "estrutura assimétrica dinâmica",
  "estrutura em mosaico",
];

const prompt = `Você é um avaliador treinado no Teste das Pirâmides Coloridas de Pfister.

Sua tarefa é classificar APENAS o ASPECTO FORMAL de cada pirâmide da imagem enviada.

Responda exclusivamente com 3 linhas, no formato abaixo:

P1: <categoria>;
P2: <categoria>;
P3: <categoria>.

Regras obrigatórias:
- NÃO explique.
- NÃO justifique.
- NÃO descreva o padrão visual.
- NÃO faça diagnóstico.
- NÃO interprete personalidade.
- NÃO use tópicos, comentários ou texto adicional.
- Escolha exatamente 1 categoria para cada pirâmide.
- Se houver mistura de padrões, escolha a categoria visualmente dominante.
- Se a imagem tiver 3 pirâmides lado a lado, considere:
  P1 = esquerda;
  P2 = meio;
  P3 = direita.

Categorias permitidas:
tapete puro
tapete desequilibrado
tapete furado ou rasgado
tapete com início de ordem
formação em camadas
formação simétrica
formação alternada
estrutura simétrica
estrutura em escada
estrutura em manto
estrutura assimétrica dinâmica
estrutura em mosaico

Critérios resumidos:
- tapete puro: distribuição livre, aleatória, mas visualmente equilibrada.
- tapete desequilibrado: distribuição livre com contraste, peso visual ou aglomeração de cores.
- tapete furado ou rasgado: presença de branco/área vazia chamando atenção como falha no preenchimento.
- tapete com início de ordem: distribuição ainda livre, mas com algumas repetições simétricas.
- formação em camadas: organização horizontal por camadas de cor/tonalidade.
- formação simétrica: pares simétricos dentro das camadas.
- formação alternada: alternância tipo xadrez usando apenas 2 cores/tons.
- estrutura simétrica: simetria horizontal e vertical integrada.
- estrutura em escada: padrão diagonal claro, como degraus.
- estrutura em manto: borda externa de uma cor envolvendo o interior.
- estrutura assimétrica dinâmica: composição elaborada com triângulos de cores repetidas entrelaçados.
- estrutura em mosaico: intenção de representar uma figura, objeto ou cena.

A saída deve conter somente isto:
P1: <categoria>;
P2: <categoria>;
P3: <categoria>.`;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function extractOutputText(data: any) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const parts: string[] = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function normalizeCategory(value: string) {
  const cleaned = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.;:]+$/g, "")
    .trim();

  return allowedCategories.find((category) => {
    const normalized = category
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return normalized === cleaned;
  }) || null;
}

function parseClassification(text: string) {
  const out: Record<string, string | null> = { P1: null, P2: null, P3: null };
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^(P[123])\s*:\s*(.+?)\s*;?\.?\s*$/i);
    if (!match) continue;
    out[match[1].toUpperCase()] = normalizeCategory(match[2]);
  }
  return out;
}

async function validatePatientToken(token: string, testCode: string) {
  if (!token || testCode !== TEST_CODE) return { ok: false, error: "Token ou formulário inválido." };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, error: "Supabase service role não configurada." };

  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_patient_form_access`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_token: token,
      p_form_code: testCode,
    }),
  });

  if (!response.ok) return { ok: false, error: "Não foi possível validar o acesso do paciente." };
  const data = await response.json();
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.form_code !== TEST_CODE) return { ok: false, error: "Link inválido ou expirado." };

  return { ok: true, cpf: row.cpf || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido." }, 405);
  if (!OPENAI_API_KEY) return jsonResponse({ error: "OPENAI_API_KEY não configurada na Edge Function." }, 500);

  try {
    const body = await req.json();
    const imageUrl = String(body?.image_url || body?.imageUrl || "").trim();
    const token = String(body?.token || "").trim();
    const testCode = String(body?.test_code || body?.code || "").trim();

    const access = await validatePatientToken(token, testCode);
    if (!access.ok) return jsonResponse({ error: access.error }, 401);

    if (!/^https?:\/\//i.test(imageUrl)) {
      return jsonResponse({ error: "image_url pública é obrigatória." }, 400);
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        }],
        max_output_tokens: 120,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return jsonResponse({
        error: data?.error?.message || "Falha ao classificar imagem na OpenAI.",
        status: response.status,
      }, 502);
    }

    const outputText = extractOutputText(data);
    const classificacao = parseClassification(outputText);
    const valid = ["P1", "P2", "P3"].every((key) => !!classificacao[key]);

    return jsonResponse({
      ok: valid,
      model: OPENAI_MODEL,
      output_text: outputText,
      classificacao,
      image_url: imageUrl,
    });
  } catch (err) {
    return jsonResponse({
      error: err instanceof Error ? err.message : "Erro inesperado ao classificar imagem.",
    }, 500);
  }
});
