# archa-dash

Dash de aprovação do ARCHA: lista os pedidos que o Hermes extraiu/validou (Postgres schema `archa`),
Gabriel corrige/aprova, e o clique em **Enviar** cria o pedido no Bling (API v3, token vivo de
`crm.bling_tokens`). Correção de SKU aprovada vira linha em `archa.sku_map` (de/para aprende).

Contexto, contrato de dados e decisões: `../README.md` e `../02-schema.sql` (vault MAGNUS, `sinteseia/07-archa/`).

## Rodar local

```bash
npm install
cp .env.example .env.local   # preencher DATABASE_URL (archa_app) e ARCHA_PASSWORD
npm run seed                 # insere pedido de teste
npm run dev                  # http://localhost:8080 (basic auth)
```

## Deploy (padrão cells-analytics)

- **EasePanel** projeto `sintese`, serviço `archa-dash`, build por Dockerfile deste repo GitHub (branch `main`).
- **Env:** `DATABASE_URL` com host interno `bancodados:5432` (rede interna — banco nunca exposto pro app), `ARCHA_USER`, `ARCHA_PASSWORD`, `PORT=8080`.
- **Domínio:** `archa.sinteseia.com.br` → porta 8080, `certificateResolver: 'letsencrypt'` (⚠️ criar já com letsencrypt; corrigir depois exige delete+create do domínio).
- **DNS:** A `archa.sinteseia.com.br` → `168.231.98.206` (mesmo padrão do hermes).
- Redeploy via API: `services.app.deployService` com `{"projectName":"sintese","serviceName":"archa-dash"}`.
- ⚠️ Ao validar deploy, procurar marcador do código novo — o container antigo continua servindo durante o build.
