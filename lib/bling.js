import { q } from './db.js';

const BASE = process.env.BLING_BASE || 'https://api.bling.com.br/Api/v3';

// Token OAuth vivo mantido pelo n8n (workflow BLING_TOKEN, refresh ~5h).
// Nós SÓ LEMOS o token — nunca fazer refresh aqui (invalidaria o do n8n).
async function getToken() {
  const rows = await q('SELECT access_token FROM crm.bling_tokens WHERE id = 1');
  if (!rows.length || !rows[0].access_token) throw new Error('token Bling ausente em crm.bling_tokens');
  return rows[0].access_token;
}

async function blingFetch(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

/**
 * Cria o pedido de venda no Bling (API v3: POST /pedidos/vendas).
 * Recebe a order + items já aprovados. Exige bling_contato_id resolvido —
 * o Bling casa contato por CPF/CNPJ e criar contato novo é proibido aqui
 * (é a causa conhecida dos duplicados; ver infra/databases.md §Bling).
 */
export async function criarPedido(order, items) {
  if (!order.bling_contato_id) throw new Error('pedido sem bling_contato_id resolvido');

  const payload = {
    contato: { id: Number(order.bling_contato_id) },
    data: new Date().toISOString().slice(0, 10),
    itens: items.map((it) => ({
      ...(it.bling_produto_id ? { produto: { id: Number(it.bling_produto_id) } } : {}),
      codigo: it.sku || undefined,
      descricao: it.descricao || it.raw_desc || it.sku,
      unidade: it.unidade || undefined,
      quantidade: Number(it.quantidade),
      valor: Number(it.preco_unit || 0),
    })),
    ...(order.po_number ? { numeroPedidoCompra: String(order.po_number) } : {}),
    observacoes: `ARCHA #${order.id}` + (order.source_ref ? ` · origem e-mail ${order.source_ref}` : ''),
  };

  const { status, body } = await blingFetch('/pedidos/vendas', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (status === 403) {
    throw Object.assign(
      new Error('Bling recusou por escopo (403 insufficient_scope) — habilitar escopo de escrita de pedidos no painel do Bling e reautorizar o app (pendência nº 1 do README do projeto)'),
      { payload, blingStatus: status, blingBody: body }
    );
  }
  if (status < 200 || status >= 300) {
    throw Object.assign(new Error(`Bling respondeu ${status}`), { payload, blingStatus: status, blingBody: body });
  }

  const data = body?.data || {};
  return { blingId: data.id ?? null, numero: data.numero ?? null, payload, blingBody: body };
}
