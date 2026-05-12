import dotenv from "dotenv";
dotenv.config();
// ============================================================
// Agente WhatsApp — Dietista-Nutricionista Víctor Meseguer
// Stack: Node.js + Express + Twilio WhatsApp + Claude API
// ============================================================

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Sistema de memoria de sesiones (en producción usa Redis) ──
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { messages: [], lead: {} });
  }
  return sessions.get(phone);
}

// ── System prompt ─────────────────────────────────────────────
const SYSTEM_PROMPT = `
Eres el asistente virtual de Víctor Meseguer, Dietista-Nutricionista. Tu nombre es Víctor AI.

PERSONALIDAD:
- Cercano, empático y profesional
- Mensajes cortos (máximo 3-4 frases). WhatsApp no es email.
- Usa emojis con moderación (1-2 por mensaje)
- Responde siempre en el idioma del usuario

SERVICIOS:
- Nutrición Clínica (patologías: diabetes, colesterol, celiaquía, etc.)
- Nutrición Deportiva
- Embarazo y Lactancia
- Pérdida de Peso
- Ganancia de Masa Muscular

PRECIOS:
- Pack inicial (primeras 2 citas): 66€
- A partir de la 3ª cita: 36€/consulta

FLUJO:
1. Saluda y pregunta en qué puedes ayudar
2. Identifica el objetivo del usuario
3. Recomienda el servicio adecuado con beneficios concretos
4. Cuando muestre interés, recoge: nombre, email, objetivo y disponibilidad
5. Confirma que Víctor contactará en menos de 24h

ESCALADO A HUMANO — responde exactamente con "ESCALAR_HUMANO" si:
- El usuario pregunta algo clínico que requiere valoración médica
- Ha dejado sus datos y está listo para agendar
- Lleva más de 3 mensajes sin resolver su duda
- Lo pide explícitamente

REGLAS:
- Nunca des diagnósticos ni consejos médicos específicos
- No inventes información sobre disponibilidad o precios
- No menciones competidores
`;

// ── Detectar si hay que escalar ───────────────────────────────
function shouldEscalate(text) {
  return text.includes("ESCALAR_HUMANO");
}

// ── Notificar escalado (adapta a tu canal: email, Slack, etc.) ─
async function notifyEscalation(phone, session) {
  console.log("🚨 ESCALADO A HUMANO");
  console.log("  Teléfono:", phone);
  console.log("  Lead:", session.lead);
  console.log("  Historial:", session.messages.slice(-4));
  // Aquí integra: sendgrid, slack webhook, etc.
}

// ── Llamada a Claude ──────────────────────────────────────────
async function getAgentReply(session) {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: session.messages,
  });
  return response.content[0].text;
}

// ── Webhook de Twilio ─────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const phone = req.body.From;       // e.g. whatsapp:+34612345678
  const incomingMsg = req.body.Body?.trim();

  if (!phone || !incomingMsg) {
    return res.status(400).send("Bad request");
  }

  const session = getSession(phone);

  // Añadir mensaje del usuario al historial
  session.messages.push({ role: "user", content: incomingMsg });

  // Extraer datos de lead si los menciona (simple heurística)
  const emailMatch = incomingMsg.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) session.lead.email = emailMatch[0];

  let replyText;
  let escalated = false;

  try {
    replyText = await getAgentReply(session);

    if (shouldEscalate(replyText)) {
      escalated = true;
      await notifyEscalation(phone, session);
      replyText = "Esta pregunta merece la atención directa de Víctor. 🙌 Le he pasado tu consulta y te contactará lo antes posible, normalmente en menos de 24h.";
    }
  } catch (err) {
    console.error("Claude error:", err);
    replyText = "Lo siento, ha habido un error técnico. Por favor inténtalo de nuevo en unos segundos.";
  }

  // Añadir respuesta al historial
  session.messages.push({ role: "assistant", content: replyText });

  // Limitar historial a últimos 20 mensajes (evitar tokens excesivos)
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  // Respuesta en formato TwiML para Twilio
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message><Body>${replyText}</Body></Message>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ── Endpoint de salud ─────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Agente WhatsApp corriendo en puerto ${PORT}`));