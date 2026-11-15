// Backup semanal do Firestore (projeto demandas-limp-rp)
// Roda no GitHub Actions (ver .github/workflows/backup-firestore.yml).
// Baixa TODAS as coleções do sistema pela API REST e salva em arquivos JSON
// na pasta ./backup — o workflow depois guarda essa pasta como "artefato"
// (fica disponível pra download na aba Actions do GitHub por 90 dias).
//
// Os documentos são salvos no formato original da API REST do Firestore
// (campo "fields" com os tipos), o que permite restaurar depois exatamente
// como estavam, inclusive datas (timestamps) e fotos.

import { mkdir, writeFile } from 'node:fs/promises';

const PROJECT = 'demandas-limp-rp';
// Mesma chave pública que já está no index.html do site.
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyAOeJwqEKzVQNtKdQgFmgo7F4w1Xl2gno8';
const COLECOES = [
  'demandas',
  'demandas_concluidas_resumo',
  'estatisticas_mensais',
  'servicos_area',
];
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PAGE_SIZE = 50; // páginas pequenas: as demandas têm fotos em base64

async function baixarColecao(nome) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `${BASE}/${nome}?pageSize=${PAGE_SIZE}&key=${API_KEY}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    let res, tentativa = 0;
    while (true) {
      tentativa++;
      res = await fetch(url);
      if (res.ok) break;
      const corpo = await res.text();
      if (tentativa >= 3) throw new Error(`Falha ao ler "${nome}" (HTTP ${res.status}): ${corpo.slice(0, 300)}`);
      console.warn(`  "${nome}": HTTP ${res.status}, tentando de novo em 5s…`);
      await new Promise(r => setTimeout(r, 5000));
    }
    const json = await res.json();
    if (json.documents) docs.push(...json.documents);
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return docs;
}

const data = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
await mkdir('backup', { recursive: true });

const resumo = { projeto: PROJECT, geradoEm: new Date().toISOString(), colecoes: {} };
for (const nome of COLECOES) {
  console.log(`Baixando "${nome}"…`);
  const docs = await baixarColecao(nome);
  const conteudo = JSON.stringify({ colecao: nome, total: docs.length, documentos: docs });
  await writeFile(`backup/${nome}.json`, conteudo);
  resumo.colecoes[nome] = { documentos: docs.length, megabytes: +(Buffer.byteLength(conteudo) / 1048576).toFixed(2) };
  console.log(`  ✓ ${docs.length} documentos (${resumo.colecoes[nome].megabytes} MB)`);
}
await writeFile('backup/_resumo.json', JSON.stringify(resumo, null, 2));

// Segurança: se a coleção principal vier vazia, algo está errado (regras
// vencidas, chave errada ou banco apagado) — falha o workflow pra você ser
// avisado por e-mail pelo GitHub, em vez de guardar um backup vazio.
if (!resumo.colecoes.demandas.documentos) {
  console.error('ATENÇÃO: a coleção "demandas" veio vazia. Backup marcado como falho.');
  process.exit(1);
}
console.log(`\nBackup de ${data} concluído.`);
