import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, logEvent } from './lib/db.js';
import { criarPedido } from './lib/bling.js';

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
