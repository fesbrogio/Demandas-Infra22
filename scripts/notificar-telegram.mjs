// ══════════════════════════════════════════════════════════════════════════
// Notifica no Telegram as demandas com "Marcar data" cujo evento é amanhã.
//
// Não precisa de nenhuma credencial de serviço do Firebase: as regras do
// Firestore deste projeto estão abertas até 01/01/2027 (allow read, write),
// então este script fala diretamente com a API REST do Firestore, do mesmo
// jeito que qualquer navegador acessando o site faria.
//
// A única credencial necessária é o token do bot do Telegram, guardado como
// "secret" no repositório do GitHub (nunca fica exposto no código).
// ══════════════════════════════════════════════════════════════════════════

const PROJECT_ID = "demandas-limp-rp";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN não definido. Configure em Settings > Secrets and variables > Actions no repositório.");
  process.exit(1);
}

// Brasil está sempre em UTC-3 (sem horário de verão desde 2019).
function amanhaISO() {
  const agoraUTC = new Date();
  const agoraBR = new Date(agoraUTC.getTime() - 3 * 60 * 60 * 1000);
  const amanha = new Date(agoraBR);
  amanha.setUTCDate(amanha.getUTCDate() + 1);
  const y = amanha.getUTCFullYear();
  const m = String(amanha.getUTCMonth() + 1).padStart(2, "0");
  const d = String(amanha.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoParaBR(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Lê um campo de um documento no formato "fields" da API REST do Firestore.
function campo(doc, nome) {
  const v = doc.fields?.[nome];
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  return null;
}

async function buscarDemandasComData() {
  const query = {
    structuredQuery: {
      from: [{ collectionId: "demandas" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "marcarData" },
          op: "EQUAL",
          value: { booleanValue: true },
        },
      },
    },
  };
  const res = await fetch(`${BASE_URL}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) {
    throw new Error(`Falha ao consultar Firestore (demandas): ${res.status} ${await res.text()}`);
  }
  const linhas = await res.json();
  return linhas.filter((l) => l.document).map((l) => l.document);
}

async function buscarChatIds() {
  const res = await fetch(`${BASE_URL}/config/notificacoes_telegram`);
  if (!res.ok) {
    console.warn("⚠️  Documento config/notificacoes_telegram não encontrado. Nenhum destinatário cadastrado.");
    return [];
  }
  const doc = await res.json();
  const arr = doc.fields?.chatIds?.arrayValue?.values || [];
  return arr.map((v) => v.integerValue || v.stringValue).filter(Boolean);
}

async function marcarComoNotificado(nomeCompletoDoc) {
  const url = `https://firestore.googleapis.com/v1/${nomeCompletoDoc}?updateMask.fieldPaths=notificadoEvento`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { notificadoEvento: { booleanValue: true } } }),
  });
  if (!res.ok) {
    console.error(`❌ Falha ao marcar ${nomeCompletoDoc} como notificado: ${res.status} ${await res.text()}`);
  }
}

async function enviarMensagemTelegram(chatId, texto) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    console.error(`❌ Falha ao enviar para chat_id ${chatId}: ${res.status} ${await res.text()}`);
  } else {
    console.log(`✓ Mensagem enviada para chat_id ${chatId}`);
  }
}

function montarMensagem(doc) {
  const g = (nome) => campo(doc, nome) || "—";
  const dataEvento = campo(doc, "dataEvento");
  const urgente = campo(doc, "prioridade") === "urgente";
  return (
    `📅 <b>Evento marcado para amanhã (${isoParaBR(dataEvento)})</b>\n\n` +
    `<b>${g("descricao")}</b>\n\n` +
    `📍 <b>Endereço:</b> ${g("endereco")}\n` +
    `🗺️ <b>Zona:</b> ${g("zona")}\n` +
    `👷 <b>Equipe:</b> ${g("equipe")}\n` +
    `👤 <b>Solicitante:</b> ${g("solicitante")}\n` +
    `${urgente ? "⚡ <b>Prioridade: URGENTE</b>\n" : ""}` +
    `🗓️ <b>Aberta em:</b> ${g("data")} às ${g("hora")}`
  );
}

async function main() {
  const amanha = amanhaISO();
  console.log(`Verificando eventos marcados para ${amanha}...`);

  const demandas = await buscarDemandasComData();
  const pendentes = demandas.filter((doc) => {
    const dataEvento = campo(doc, "dataEvento");
    const jaNotificado = campo(doc, "notificadoEvento");
    return dataEvento === amanha && !jaNotificado;
  });

  if (!pendentes.length) {
    console.log("Nenhum evento marcado para amanhã. Nada a fazer.");
    return;
  }

  const chatIds = await buscarChatIds();
  if (!chatIds.length) {
    console.log("Nenhum destinatário cadastrado em config/notificacoes_telegram. Avisos não enviados.");
    return;
  }

  for (const doc of pendentes) {
    const mensagem = montarMensagem(doc);
    for (const chatId of chatIds) {
      await enviarMensagemTelegram(chatId, mensagem);
    }
    await marcarComoNotificado(doc.name);
    console.log(`✓ Aviso processado: ${campo(doc, "descricao")}`);
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
