import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, logEvent } from './lib/db.js';
import { criarPedido, blingGet, blingPost } from './lib/bling.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- basic auth (padrão da casa: auth no app, não no proxy) ----
const USER = process.env.ARCHA_USER || 'gabriel';
const PASS = process.env.ARCHA_PASSWORD;
if (!PASS) { console.error('ARCHA_PASSWORD não definido'); process.exit(1); }

function safeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
app.use((req, res, next) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEq(u, USER) && safeEq(p.join(':'), PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="archa"').status(401).send('auth');
});

app.use(express.static(path.join(__dirname, 'public')));

const EDITAVEL = ['extraido', 'pronto', 'excecao'];

async function getOrder(id) {
  const [order] = await q('SELECT * FROM archa.orders WHERE id = $1', [id]);
  if (!order) return null;
  order.items = await q('SELECT * FROM archa.order_items WHERE order_id = $1 ORDER BY id', [id]);
  return order;
}

// ---- API ----

app.get('/api/orders', async (req, res, next) => {
  try {
    const counts = await q('SELECT status, count(*)::int AS n FROM archa.orders GROUP BY status');
    const params = [];
    let where = "status <> 'descartado'";
    if (req.query.status) { params.push(req.query.status); where = `status = $1`; }
    const orders = await q(
      `SELECT o.*, (SELECT count(*)::int FROM archa.order_items i WHERE i.order_id = o.id) AS n_itens
       FROM archa.orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`, params);
    res.json({ counts, orders });
  } catch (e) { next(e); }
});

app.get('/api/orders/:id', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    order.events = await q('SELECT * FROM archa.events WHERE order_id = $1 ORDER BY id', [req.params.id]);
    res.json(order);
  } catch (e) { next(e); }
});

// Edição (campos do pedido e/ou itens) — só antes de aprovar
app.patch('/api/orders/:id', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (!EDITAVEL.includes(order.status)) return res.status(409).json({ error: `status ${order.status} não é editável` });

    const { cliente_cnpj, bling_contato_id, po_number, entrega_data, pagamento_condicao, items } = req.body;
    await pool.query(
      `UPDATE archa.orders SET
         cliente_cnpj = COALESCE($2, cliente_cnpj),
         bling_contato_id = COALESCE($3, bling_contato_id),
         po_number = COALESCE($4, po_number),
         entrega_data = COALESCE($5, entrega_data),
         pagamento_condicao = COALESCE($6, pagamento_condicao),
         updated_at = now()
       WHERE id = $1`,
      [order.id, cliente_cnpj, bling_contato_id, po_number, entrega_data, pagamento_condicao]);

    for (const it of items || []) {
      await pool.query(
        `UPDATE archa.order_items SET
           sku = COALESCE($3, sku), bling_produto_id = COALESCE($4, bling_produto_id),
           descricao = COALESCE($5, descricao), quantidade = COALESCE($6, quantidade),
           preco_unit = COALESCE($7, preco_unit), unidade = COALESCE($8, unidade)
         WHERE id = $2 AND order_id = $1`,
        [order.id, it.id, it.sku, it.bling_produto_id, it.descricao, it.quantidade, it.preco_unit, it.unidade]);
    }
    await pool.query(
      `UPDATE archa.orders o SET total_estimado =
         (SELECT COALESCE(sum(quantidade * COALESCE(preco_unit,0)),0) FROM archa.order_items WHERE order_id = o.id)
       WHERE o.id = $1`, [order.id]);

    await logEvent(order.id, 'gabriel', 'editado', { body: req.body });
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Aprovar: registra decisão humana e ALIMENTA O DE/PARA (correção vira aprendizado)
app.post('/api/orders/:id/approve', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (!EDITAVEL.includes(order.status)) return res.status(409).json({ error: `status ${order.status} não aprovável` });

    const overrode = order.status === 'excecao';
    await pool.query(`UPDATE archa.orders SET status = 'aprovado', updated_at = now() WHERE id = $1`, [order.id]);
    await logEvent(order.id, 'gabriel', 'aprovado', { excecoes_sobrepostas: overrode ? order.exceptions : [] });

    const cnpj = (order.cliente_cnpj || '').replace(/\D/g, '');
    if (cnpj) {
      for (const it of order.items) {
        if (it.raw_desc && it.sku) {
          await pool.query(
            `INSERT INTO archa.sku_map (cliente_chave, alias, sku, bling_produto_id, origem)
             VALUES ($1, lower(trim($2)), $3, $4, 'humano')
             ON CONFLICT (cliente_chave, alias) DO UPDATE SET sku = EXCLUDED.sku,
               bling_produto_id = EXCLUDED.bling_produto_id`,
            [cnpj, it.raw_desc, it.sku, it.bling_produto_id]);
        }
        // preço aprovado vira tabela B2B do cliente (regra 4 valida contra isso primeiro)
        if (it.sku && it.preco_unit != null) {
          await pool.query(
            `INSERT INTO archa.price_table (cliente_chave, sku, preco, origem)
             VALUES ($1, $2, $3, 'humano')
             ON CONFLICT (cliente_chave, sku) DO UPDATE SET preco = EXCLUDED.preco,
               origem = 'humano', updated_at = now()`,
            [cnpj, it.sku, it.preco_unit]);
        }
      }
    }
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Enviar pro Bling — só pedido aprovado (ou retry de erro)
app.post('/api/orders/:id/send', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (!['aprovado', 'erro'].includes(order.status)) return res.status(409).json({ error: `status ${order.status} não enviável` });

    try {
      const r = await criarPedido(order, order.items);
      await pool.query(
        `UPDATE archa.orders SET status = 'enviado', bling_pedido_id = $2, bling_pedido_numero = $3, updated_at = now() WHERE id = $1`,
        [order.id, r.blingId, r.numero]);
      await logEvent(order.id, 'dash', 'enviado_bling', { payload: r.payload, resposta: r.blingBody });
      res.json(await getOrder(order.id));
    } catch (err) {
      await pool.query(`UPDATE archa.orders SET status = 'erro', updated_at = now() WHERE id = $1`, [order.id]);
      await logEvent(order.id, 'dash', 'erro_bling', {
        erro: err.message, status: err.blingStatus ?? null, resposta: err.blingBody ?? null, payload: err.payload ?? null,
      });
      res.status(502).json({ error: err.message, order: await getOrder(order.id) });
    }
  } catch (e) { next(e); }
});

// Cliente não encontrado → cadastra no Bling. Regras: (1) SEMPRE busca por CNPJ antes —
// se já existe, só vincula (a proibição de criar contato era contra DUPLICADOS, não contra
// cadastro legítimo); (2) dados vêm da Receita via BrasilAPI pra ninguém digitar.
// Escopo de escrita de contatos validado 05/09 (POST /contatos = 201).
app.post('/api/orders/:id/cadastrar-cliente', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (order.bling_contato_id) return res.status(409).json({ error: 'pedido já tem contato vinculado' });
    const cnpj = String(req.body?.cnpj || order.cliente_cnpj || '').replace(/\D/g, '');
    if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido — preencha o campo CNPJ antes' });

    // 1) já existe no Bling? só vincula
    const busca = await blingGet(`/contatos?numeroDocumento=${cnpj}`);
    let contato = (busca.body?.data || []).find((x) => (x.numeroDocumento || '').replace(/\D/g, '') === cnpj);
    let criado = false;

    if (!contato) {
      // 2) consulta Receita (BrasilAPI) e cria
      const rf = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      const dados = rf.ok ? await rf.json() : null;
      const payload = {
        nome: dados?.razao_social || order.cliente_nome || `CNPJ ${cnpj}`,
        fantasia: dados?.nome_fantasia || undefined,
        tipo: 'J',
        numeroDocumento: cnpj,
        situacao: 'A',
        indicadorIe: 9, // não contribuinte por padrão — ajustar no Bling se tiver IE
        telefone: dados?.ddd_telefone_1 || undefined,
        endereco: dados?.cep ? { geral: {
          endereco: [dados.descricao_tipo_de_logradouro, dados.logradouro].filter(Boolean).join(' '),
          numero: dados.numero || 'S/N', complemento: dados.complemento || undefined,
          bairro: dados.bairro || undefined, cep: String(dados.cep).replace(/\D/g, ''),
          municipio: dados.municipio || undefined, uf: dados.uf || undefined,
        } } : undefined,
      };
      const { status, body } = await blingPost('/contatos', payload);
      if (status >= 300 || !body?.data?.id) return res.status(502).json({ error: `Bling respondeu ${status}`, resposta: body });
      contato = { id: body.data.id, nome: payload.nome, numeroDocumento: cnpj };
      criado = true;
    }

    const excecoes = (order.exceptions || []).filter((e) => e.regra !== 'cliente');
    await pool.query(
      `UPDATE archa.orders SET bling_contato_id=$2, cliente_cnpj=$3, exceptions=$4, updated_at=now() WHERE id=$1`,
      [order.id, contato.id, cnpj, JSON.stringify(excecoes)]);
    await logEvent(order.id, 'gabriel', criado ? 'cliente_cadastrado' : 'cliente_vinculado',
      { bling_contato_id: contato.id, nome: contato.nome, cnpj, fonte: criado ? 'BrasilAPI + POST /contatos' : 'match por CNPJ' });
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Gera a NF-e em rascunho a partir do pedido de venda (validado 05/09: POST gerar-nfe = 201)
app.post('/api/orders/:id/gerar-nf', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (order.status !== 'enviado' || !order.bling_pedido_id) return res.status(409).json({ error: 'precisa estar enviado ao Bling' });
    if (order.nf_id) return res.status(409).json({ error: `já tem NF (${order.nf_numero || order.nf_id})` });
    const { status, body } = await blingPost(`/pedidos/vendas/${order.bling_pedido_id}/gerar-nfe`);
    const nfId = body?.data?.idNotaFiscal;
    if (status >= 300 || !nfId) return res.status(502).json({ error: `Bling respondeu ${status}`, resposta: body });
    const det = await blingGet(`/nfe/${nfId}`);
    const n = det.body?.data || {};
    await pool.query(
      `UPDATE archa.orders SET nf_id=$2, nf_numero=$3, nf_situacao=$4, nf_emissao=$5, nf_link=$6, updated_at=now() WHERE id=$1`,
      [order.id, nfId, n.numero || null, n.situacao ?? null, n.dataEmissao || null, n.linkDanfe || n.linkPDF || null]);
    await logEvent(order.id, 'gabriel', 'nf_gerada', { nf_id: nfId, numero: n.numero, situacao: n.situacao });
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Autoriza a NF na SEFAZ (ato fiscal — sempre clique humano, nunca automático)
app.post('/api/orders/:id/autorizar-nf', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (!order.nf_id) return res.status(409).json({ error: 'sem NF gerada' });
    if (order.nf_situacao === 6) return res.status(409).json({ error: 'NF já autorizada' });
    const { status, body } = await blingPost(`/nfe/${order.nf_id}/enviar`);
    if (status >= 300) return res.status(502).json({ error: `Bling respondeu ${status}`, resposta: body });
    const det = await blingGet(`/nfe/${order.nf_id}`);
    const n = det.body?.data || {};
    await pool.query(
      `UPDATE archa.orders SET nf_situacao=$2, nf_link=COALESCE($3, nf_link), nf_emissao=COALESCE($4, nf_emissao), updated_at=now() WHERE id=$1`,
      [order.id, n.situacao ?? null, n.linkDanfe || n.linkPDF || null, n.dataEmissao || null]);
    await logEvent(order.id, 'gabriel', 'nf_autorizada', { nf_id: order.nf_id, situacao: n.situacao, resposta: body?.data ?? null });
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Frame de confirmação (versão manual do MVP): pediu confirmação → aguardando_cliente
app.post('/api/orders/:id/request-confirmation', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (!EDITAVEL.includes(order.status)) return res.status(409).json({ error: `status ${order.status} não permite pedir confirmação` });
    await pool.query(`UPDATE archa.orders SET status = 'aguardando_cliente', updated_at = now() WHERE id = $1`, [order.id]);
    await logEvent(order.id, 'gabriel', 'confirmacao_solicitada', { para: order.source_from || null });
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Cliente confirmou o frame → volta pronto (com aprendizado origem confirmado_cliente)
app.post('/api/orders/:id/client-confirmed', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (order.status !== 'aguardando_cliente') return res.status(409).json({ error: `status ${order.status} não aguarda cliente` });
    await pool.query(`UPDATE archa.orders SET status = 'pronto', confidence = 100, updated_at = now() WHERE id = $1`, [order.id]);
    await logEvent(order.id, 'gabriel', 'confirmado_cliente', { excecoes_resolvidas: order.exceptions || [] });
    const cnpj = (order.cliente_cnpj || '').replace(/\D/g, '');
    if (cnpj) {
      for (const it of order.items) {
        if (it.raw_desc && it.sku) {
          await pool.query(
            `INSERT INTO archa.sku_map (cliente_chave, alias, sku, bling_produto_id, origem)
             VALUES ($1, lower(trim($2)), $3, $4, 'confirmado_cliente')
             ON CONFLICT (cliente_chave, alias) DO UPDATE SET sku = EXCLUDED.sku,
               bling_produto_id = EXCLUDED.bling_produto_id`,
            [cnpj, it.raw_desc, it.sku, it.bling_produto_id]);
        }
        if (it.sku && it.preco_unit != null) {
          await pool.query(
            `INSERT INTO archa.price_table (cliente_chave, sku, preco, origem)
             VALUES ($1, $2, $3, 'confirmado_cliente')
             ON CONFLICT (cliente_chave, sku) DO UPDATE SET preco = EXCLUDED.preco, updated_at = now()`,
            [cnpj, it.sku, it.preco_unit]);
        }
      }
    }
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

// Transporte confirmado (manual — fallback quando a etiqueta é gerada fora do Bling)
app.post('/api/orders/:id/despacho', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (order.status !== 'enviado') return res.status(409).json({ error: 'só pedido enviado tem despacho' });
    await pool.query(`UPDATE archa.orders SET despachado_em = now(), rastreio = COALESCE($2, rastreio), updated_at = now() WHERE id = $1`,
      [order.id, req.body?.rastreio || null]);
    await logEvent(order.id, 'gabriel', 'despacho_confirmado', { rastreio: req.body?.rastreio || null });
    res.json(await getOrder(order.id));
  } catch (e) { next(e); }
});

app.post('/api/orders/:id/discard', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'não existe' });
    if (['enviado'].includes(order.status)) return res.status(409).json({ error: 'pedido já enviado' });
    await pool.query(`UPDATE archa.orders SET status = 'descartado', updated_at = now() WHERE id = $1`, [order.id]);
    await logEvent(order.id, 'gabriel', 'descartado', { motivo: req.body?.motivo || null });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Kanban: coluna derivada de status + campos preenchidos pelo poller (fluxo definido pelo Gabriel 05/09):
// entrada → confirmacao → erp → nf → transporte → pago
function stageOf(o) {
  if (o.pago_em) return 'pago';
  if (o.despachado_em) return 'transporte';
  if (o.nf_id) return 'nf';
  if (['aprovado', 'enviado', 'erro'].includes(o.status)) return 'erp';
  if (o.status === 'aguardando_cliente') return 'confirmacao';
  return 'entrada'; // extraido | pronto | excecao — chegou e está em tratamento
}
app.get('/api/kanban', async (_req, res, next) => {
  try {
    const orders = await q(
      `SELECT o.*, (SELECT count(*)::int FROM archa.order_items i WHERE i.order_id = o.id) AS n_itens
       FROM archa.orders o WHERE status <> 'descartado' ORDER BY o.updated_at DESC LIMIT 300`);
    res.json({ orders: orders.map((o) => ({ ...o, stage: stageOf(o) })) });
  } catch (e) { next(e); }
});

// ---- Poller: acompanha o pós-envio lendo o Bling (NF gerada → boleto pago) ----
// O fluxo manual da Cells emite NF direto (sem pedido de venda) — descoberta 05/09;
// aqui cobrimos o fluxo ARCHA: pedido criado via API → NF vinculada → conta a receber.
async function pollBling() {
  const abertos = await q(
    `SELECT id, bling_pedido_id, bling_contato_id, nf_id, nf_situacao, pago_em, despachado_em, total_estimado
     FROM archa.orders WHERE status = 'enviado' AND pago_em IS NULL AND bling_pedido_id IS NOT NULL LIMIT 50`);
  for (const o of abertos) {
    try {
      if (!o.nf_id) {
        const { status, body } = await blingGet(`/pedidos/vendas/${o.bling_pedido_id}`);
        const nf = status === 200 ? body?.data?.notaFiscal : null;
        if (nf?.id) {
          const det = await blingGet(`/nfe/${nf.id}`);
          const n = det.body?.data || {};
          await pool.query(
            `UPDATE archa.orders SET nf_id=$2, nf_numero=$3, nf_situacao=$4, nf_emissao=$5, nf_link=$6, updated_at=now() WHERE id=$1`,
            [o.id, nf.id, n.numero || null, n.situacao ?? null, n.dataEmissao || null, n.linkDanfe || n.linkPDF || null]);
          await logEvent(o.id, 'poller', 'nf_detectada', { nf_id: nf.id, numero: n.numero, situacao: n.situacao });
        }
      } else {
        const det = await blingGet(`/nfe/${o.nf_id}`);
        const n = det.body?.data || {};
        if (n.situacao != null && n.situacao !== o.nf_situacao) {
          await pool.query(`UPDATE archa.orders SET nf_situacao=$2, updated_at=now() WHERE id=$1`, [o.id, n.situacao]);
          await logEvent(o.id, 'poller', 'nf_situacao', { situacao: n.situacao });
        }
        // volumes na NF = etiqueta/postagem gerada → transporte confirmado
        const vols = n.transporte?.volumes || [];
        if (!o.despachado_em && vols.length) {
          await pool.query(`UPDATE archa.orders SET despachado_em=now(), rastreio=$2, updated_at=now() WHERE id=$1 AND despachado_em IS NULL`,
            [o.id, vols[0]?.codigoRastreamento || null]);
          await logEvent(o.id, 'poller', 'despacho_detectado', { volumes: vols.length, rastreio: vols[0]?.codigoRastreamento || null });
        }
      }
      if (o.bling_contato_id) {
        // boleto emitido no Bling? (só existe se a cobrança bancária estiver integrada — hoje não está)
        const ab = await blingGet(`/contas/receber?idContato=${o.bling_contato_id}&situacoes[]=1`);
        const aberta = (ab.body?.data || []).find((x) => Math.abs(Number(x.valor) - Number(o.total_estimado)) < 0.01);
        if (aberta) {
          const det = await blingGet(`/contas/receber/${aberta.id}`);
          const d = det.body?.data || {};
          if (d.linkBoleto || aberta.vencimento) {
            await pool.query(`UPDATE archa.orders SET boleto_link=COALESCE($2, boleto_link), boleto_vencimento=COALESCE($3, boleto_vencimento), updated_at=now() WHERE id=$1`,
              [o.id, d.linkBoleto || null, aberta.vencimento || null]);
          }
        }
        // pago = conta a receber do contato com valor compatível baixada (situacao 2/3)
        const cr = await blingGet(`/contas/receber?idContato=${o.bling_contato_id}&situacoes[]=2&situacoes[]=3`);
        const baixadas = (cr.body?.data || []).filter((x) => Math.abs(Number(x.valor) - Number(o.total_estimado)) < 0.01);
        if (baixadas.length) {
          await pool.query(`UPDATE archa.orders SET pago_em=now(), boleto_vencimento=$2, updated_at=now() WHERE id=$1 AND pago_em IS NULL`,
            [o.id, baixadas[0].vencimento || null]);
          await logEvent(o.id, 'poller', 'pagamento_detectado', { vencimento: baixadas[0].vencimento, valor: baixadas[0].valor });
        }
      }
    } catch (err) { console.error(`poller pedido ${o.id}:`, err.message); }
  }
}
setInterval(() => pollBling().catch((e) => console.error('poller:', e.message)), 10 * 60 * 1000);
setTimeout(() => pollBling().catch((e) => console.error('poller:', e.message)), 15 * 1000);

app.get('/healthz', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, '0.0.0.0', () => console.log(`archa-dash na porta ${port}`));
