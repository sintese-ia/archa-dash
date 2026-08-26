import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// jit=off: padrão da casa (ver infra/databases.md — planner superestima custo em views jsonb)
pool.on('connect', (client) => client.query('SET jit = off'));

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function logEvent(orderId, ator, tipo, payload) {
  await pool.query(
    'INSERT INTO archa.events (order_id, ator, tipo, payload) VALUES ($1,$2,$3,$4)',
    [orderId, ator, tipo, payload ? JSON.stringify(payload) : null]
  );
}
