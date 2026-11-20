# Mentez

Software de gestão para psicólogas, psicólogos e clínicas de psicologia — *Inteligência para cuidar de quem cuida.*

Plataforma multiclínica (SaaS): cada clínica tem o seu endereço (`clinica.mentez.com.br` ou um domínio próprio), o seu banco de dados e as suas chaves de criptografia.

- `app/` — o sistema (Node.js 20+, Express, MySQL)
- `infra/` — servidor (Docker Compose, Caddy com HTTPS automático)

Origem: sistema do consultório Lorrainy Mendes (repositório `aurelioazevedo/LorrainyMendes`, pasta `sistema/`, versão 39ec746).

## Como funciona a separação das clínicas

- Banco da plataforma (`mentez_platform`): clínicas, domínios próprios e as chaves de cada clínica (cifradas com `MENTEZ_MASTER_KEY`).
- Um banco por clínica (`mz_<endereco>`), com o mesmo esquema do sistema original.
- Cada requisição é atendida no contexto da clínica do endereço acessado (`app/lib/tenancy.js`); `lib/db.js` escolhe o banco sozinho.
- Chaves próprias por clínica: criptografia dos dados de saúde e assinatura das sessões. O login de uma clínica não abre outra.
- Caches em memória e tarefas automáticas separados por clínica.
- HTTPS: o Caddy emite o certificado de cada endereço na primeira visita, depois de confirmar com o app (`/_mentez/tls`) que pertence a uma clínica ativa.

## Clínicas (dentro do contêiner do app)

```
node scripts/mentez.js criar aurelio "Dr. Aurélio Azevedo"
node scripts/mentez.js admin aurelio "Aurélio Azevedo" email@exemplo.com
node scripts/mentez.js dominio aurelio app.aurelioazevedo.com --principal
node scripts/mentez.js clinicas
```

Sem `MENTEZ_PLATFORM_DB`, o app funciona como antes, com uma clínica só (variáveis `DB_*`).

## Publicação na VPS

1. `infra/vps-sync.yml` (projeto `mentez-sync` no Docker Manager): baixa o código para `/opt/mentez/src` com a deploy key só de leitura que fica na VPS (`/opt/mentez/keys/deploy`).
2. `infra/vps.yml` (projeto `mentez`): monta e sobe app, MySQL e Caddy a partir de `/opt/mentez/src`.

Os segredos ficam em `/opt/mentez/.env`, gerados na própria VPS. **Guarde uma cópia da `MENTEZ_MASTER_KEY`** em local seguro (gerenciador de senhas): sem ela as chaves das clínicas não abrem.
