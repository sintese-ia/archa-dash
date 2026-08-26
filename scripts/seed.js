// Insere um pedido de teste (como o Hermes inseriria) pra validar o dash fim-a-fim.
// Uso: npm run seed  (precisa de DATABASE_URL no .env.local)
import { pool, logEvent } from '../lib/db.js';

const [{ id }] = (await pool.query(
  `INSERT INTO archa.orders
     (source, source_ref, source_from, source_subject, raw_excerpt,
      cliente_nome, cliente_cnpj, po_number, pagamento_condicao,
      status, confidence, exceptions, total_estimado, created_by)
   VALUES ('email', 'seed-' || floor(random()*1e9)::text, 'comprador@redex.com.br',
     'Pedido semanal — Loja Paulista',
     'Gabriel, manda 12 caixas de limão para a loja da Paulista. Mesmo preço do último pedido. Pgto 28 dias.',
     'Rede X', '12.345.678/0001-90', 'PO-2026-0842', '28 dias',
     'excecao', 78, '[{"regra":"sku","detalhe":"\\"caixas de limão\\" tem 2 SKUs compatíveis: CEL-LIM-15 (84%) e CEL-LM-15 (43%)"}]',
     1054.80, 'seed')
   RETURNING id`
)).rows;

await pool.query(
  `INSERT INTO archa.order_items
     (order_id, raw_desc, sku, descricao, quantidade, unidade, preco_unit, preco_tabela, match_score, flags)
   VALUES ($1, 'caixas de limão', NULL, 'Cells Limão display 15un', 12, 'CX', 87.90, 87.90, 84, '["sku_ambiguo"]')`,
  [id]
);

await logEvent(id, 'hermes', 'extraido', { seed: true });
await logEvent(id, 'hermes', 'excecao', { regra: 'sku', candidatos: ['CEL-LIM-15', 'CEL-LM-15'] });

console.log(`pedido de teste #${id} criado (status excecao)`);
await pool.end();
