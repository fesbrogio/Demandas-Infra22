// ══════════════════════════════════════════════════════════════════════════
// Notifica no Telegram as demandas E ações especiais com "Marcar data" cujo
// evento é amanhã.
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
function hojeISO() {
  const agoraUTC = new Date();
  const agoraBR = new Date(agoraUTC.getTime() - 3 * 60 * 60 * 1000);
  const y = agoraBR.getUTCFullYear();
  const m = String(agoraBR.getUTCMonth() + 1).padStart(2, "0");
  const d = String(agoraBR.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoParaBR(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Dia anterior a uma data ISO, em formato BR — usado na mensagem de Demanda,
// já que o serviço precisa estar pronto ATÉ o dia anterior ao evento (diferente
// da Ação Especial, que é executada no próprio dia marcado).
function diaAnteriorBR(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dd}/${mm}/${yy}`;
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

// Busca documentos com marcarData == true em qualquer coleção (demandas ou
// servicos_area) — mesma consulta, só muda o nome da coleção.
async function buscarComData(collectionId) {
  const query = {
    structuredQuery: {
      from: [{ collectionId }],
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
    throw new Error(`Falha ao consultar Firestore (${collectionId}): ${res.status} ${await res.text()}`);
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

// Tenta enviar até 3 vezes, com uma pequena pausa entre tentativas — falhas de
// rede passageiras (timeout, instabilidade momentânea) costumam se resolver
// numa segunda ou terceira tentativa, sem precisar esperar o próximo dia.
async function enviarMensagemTelegram(chatId, texto, tentativa = 1) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      console.error(`❌ Falha ao enviar para chat_id ${chatId} (tentativa ${tentativa}): ${res.status} ${await res.text()}`);
      return false;
    }
    console.log(`✓ Mensagem enviada para chat_id ${chatId}`);
    return true;
  } catch (err) {
    console.error(`❌ Erro de rede ao enviar para chat_id ${chatId} (tentativa ${tentativa}): ${err.message}`);
    if (tentativa < 3) {
      await sleep(5000);
      return enviarMensagemTelegram(chatId, texto, tentativa + 1);
    }
    return false;
  }
}

// Mensagem para uma DEMANDA (coleção "demandas").
// A demanda-evento precisa estar CONCLUÍDA até o dia ANTERIOR ao evento —
// diferente da Ação Especial, que é executada no próprio dia marcado.
function montarMensagemDemanda(doc, atrasado) {
  const g = (nome) => campo(doc, nome) || "—";
  const dataEvento = campo(doc, "dataEvento");
  const urgente = campo(doc, "prioridade") === "urgente";
  return (
    `${atrasado ? "⚠️ <b>AVISO ATRASADO</b> (a verificação de ontem falhou) ⚠️\n" : ""}` +
    `📅 <b>DEMANDA-EVENTO para ${isoParaBR(dataEvento)}</b>\n` +
    `⚠️ <b>Serviço deve estar pronto até ${diaAnteriorBR(dataEvento)} (um dia antes do evento)</b>\n\n` +
    `<b>${g("descricao")}</b>\n\n` +
    `📍 <b>Endereço:</b> ${g("endereco")}\n` +
    `🗺️ <b>Zona:</b> ${g("zona")}\n` +
    `👷 <b>Equipe:</b> ${g("equipe")}\n` +
    `👤 <b>Solicitante:</b> ${g("solicitante")}\n` +
    `${urgente ? "⚡ <b>Prioridade: URGENTE</b>\n" : ""}` +
    `🗓️ <b>Aberta em:</b> ${g("data")} às ${g("hora")}`
  );
}

// Mensagem para uma AÇÃO ESPECIAL (coleção "servicos_area", tipo "acao").
// Deixa claro logo no início que é uma AÇÃO, não uma demanda — são coisas
// diferentes — e que a execução acontece NO PRÓPRIO DIA marcado (diferente
// da demanda-evento, que precisa estar pronta um dia antes).
function montarMensagemAcao(doc, atrasado) {
  const g = (nome) => campo(doc, nome) || "—";
  const dataEvento = campo(doc, "dataEvento");
  const endereco = campo(doc, "enderecoAcao");
  const obsInicial = campo(doc, "obsInicial");
  const retro = campo(doc, "necessitaRetroescavadeira");
  return (
    `⭐ <b>AÇÃO ESPECIAL marcada para ${isoParaBR(dataEvento)}</b>\n` +
    `${atrasado ? "⚠️ <b>AVISO ATRASADO</b> (a verificação de ontem falhou) — pode já ser hoje ⚠️\n" : "📌 <b>Executar neste dia</b> (aviso enviado com 1 dia de antecedência)\n"}\n` +
    `<b>${g("local")}</b>\n\n` +
    `${endereco ? `📍 <b>Endereço:</b> ${endereco}\n` : ""}` +
    `👷 <b>Equipe:</b> ${g("equipe")}\n` +
    `${retro ? "🚜 <b>Necessita retroescavadeira</b>\n" : ""}` +
    `${obsInicial ? `📝 <b>Observação inicial:</b> ${obsInicial}\n` : ""}` +
    `🗓️ <b>Criada em:</b> ${g("dataCriacao")}`
  );
}

async function main() {
  const hoje = hojeISO();
  const amanha = amanhaISO();
  console.log(`Verificando eventos marcados para hoje (${hoje}) e amanhã (${amanha})...`);

  const [demandas, acoes] = await Promise.all([
    buscarComData("demandas"),
    buscarComData("servicos_area"),
  ]);

  const candidatos = [
    ...demandas.map((doc) => ({ doc, origem: "demanda" })),
    ...acoes.map((doc) => ({ doc, origem: "acao" })),
  ];

  // Verifica "amanhã" (caso normal, aviso com 1 dia de antecedência) e também
  // "hoje" (rede de segurança: se a execução de ontem falhou por algum motivo
  // — rede instável, etc. — o evento de hoje ainda não teria sido avisado, e
  // aqui ele é pego e avisado atrasado, em vez de nunca ser avisado).
  const pendentes = candidatos.filter(({ doc }) => {
    const dataEvento = campo(doc, "dataEvento");
    const jaNotificado = campo(doc, "notificadoEvento");
    return (dataEvento === amanha || dataEvento === hoje) && !jaNotificado;
  });

  if (!pendentes.length) {
    console.log("Nenhum evento pendente de aviso. Nada a fazer.");
    return;
  }

  const chatIds = await buscarChatIds();
  if (!chatIds.length) {
    console.log("Nenhum destinatário cadastrado em config/notificacoes_telegram. Avisos não enviados.");
    return;
  }

  for (const { doc, origem } of pendentes) {
    const atrasado = campo(doc, "dataEvento") === hoje;
    const mensagem = origem === "acao" ? montarMensagemAcao(doc, atrasado) : montarMensagemDemanda(doc, atrasado);
    const label = origem === "acao" ? campo(doc, "local") : campo(doc, "descricao");
    // Só marca como notificado se PELO MENOS UM envio realmente funcionou.
    // Se todos falharem (ex: token inválido), o item continua pendente
    // e será tentado de novo na próxima execução do workflow.
    let algumSucesso = false;
    for (const chatId of chatIds) {
      const ok = await enviarMensagemTelegram(chatId, mensagem);
      if (ok) algumSucesso = true;
    }
    if (algumSucesso) {
      await marcarComoNotificado(doc.name);
      console.log(`✓ Aviso processado (${origem}): ${label}`);
    } else {
      console.error(`❌ Nenhum envio funcionou para (${origem}): ${label} — será tentado novamente na próxima execução.`);
    }
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});

