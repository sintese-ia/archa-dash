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

// GET simples pro poller (NF, pedido, contas a receber)
export async function blingGet(path) {
  return blingFetch(path);
}

// Forma de pagamento usada nas parcelas: "Boleto Itau - B2B" (id verificado 26/08/2026 via GET /formas-pagamentos)
const FORMA_BOLETO_ID = Number(process.env.BLING_FORMA_PAGAMENTO_ID || 8743161);

// "28 dias" → [28] · "21d" → [21] · "28/56" → [28,56] · sem número → null (Bling usa o padrão do contato)
function parsePrazos(cond) {
  if (!cond) return null;
  const dias = String(cond).match(/\d+/g)?.map(Number).filter((n) => n > 0 && n <= 365);
  return dias?.length ? dias : null;
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
    ...(() => {
      const prazos = parsePrazos(order.pagamento_condicao);
      if (!prazos || !FORMA_BOLETO_ID) return {};
      const total = items.reduce((s, it) => s + Number(it.quantidade) * Number(it.preco_unit || 0), 0);
      const porParcela = Math.floor((total / prazos.length) * 100) / 100;
      return { parcelas: prazos.map((d, i) => {
        const venc = new Date(); venc.setDate(venc.getDate() + d);
        return {
          dataVencimento: venc.toISOString().slice(0, 10),
          valor: i === prazos.length - 1 ? Math.round((total - porParcela * (prazos.length - 1)) * 100) / 100 : porParcela,
          formaPagamento: { id: FORMA_BOLETO_ID },
        };
      }) };
    })(),
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
