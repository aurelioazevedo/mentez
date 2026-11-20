import mysql from 'mysql2/promise';

function config() {
  if (process.env.DB_HOST) {
    return {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    };
  }
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL };
  throw new Error('Banco de dados não configurado (DB_HOST/DATABASE_URL).');
}

let pool;
export function db() {
  if (!pool) {
    pool = mysql.createPool({
      ...config(),
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
    });
    // Goiânia: UTC-3 (sem horário de verão) — NOW()/CURRENT_TIMESTAMP no horário local.
    pool.pool.on('connection', (conn) => conn.query("SET time_zone = '-03:00'"));
  }
  return pool;
}

export async function q(sql, params = []) {
  const [rows] = await db().query(sql, params);
  return rows;
}
export async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    totp_secret VARCHAR(255) NULL,
    totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS patients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    social_name VARCHAR(160) NULL,
    birth_date DATE NULL,
    phone VARCHAR(40) NULL,
    email VARCHAR(190) NULL,
    cpf_enc TEXT NULL,
    address_enc TEXT NULL,
    emergency_enc TEXT NULL,
    modality ENUM('online','presencial','hibrido') NOT NULL DEFAULT 'online',
    session_fee DECIMAL(10,2) NULL,
    status ENUM('ativo','pausa','alta','inativo') NOT NULL DEFAULT 'ativo',
    consent_at DATETIME NULL,
    notes_enc MEDIUMTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (status), INDEX (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    starts_at DATETIME NOT NULL,
    duration_min SMALLINT NOT NULL DEFAULT 40,
    modality ENUM('online','presencial') NOT NULL DEFAULT 'online',
    status ENUM('agendada','confirmada','realizada','falta','cancelada') NOT NULL DEFAULT 'agendada',
    meeting_link VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (starts_at), INDEX (patient_id),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    appointment_id INT NULL,
    kind ENUM('evolucao','anamnese','documento','observacao') NOT NULL DEFAULT 'evolucao',
    record_date DATE NOT NULL,
    content_enc MEDIUMTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (patient_id, record_date),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    appointment_id INT NULL,
    description VARCHAR(255) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    due_date DATE NOT NULL,
    paid_at DATE NULL,
    method ENUM('pix','dinheiro','cartao','transferencia','outro') NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (due_date), INDEX (patient_id),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    exercise_key VARCHAR(80) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    instructions TEXT NULL,
    status ENUM('enviado','aberto','respondido','revisado') NOT NULL DEFAULT 'enviado',
    response_enc MEDIUMTEXT NULL,
    expires_at DATETIME NOT NULL,
    opened_at DATETIME NULL,
    responded_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id), INDEX (status),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    action VARCHAR(60) NOT NULL,
    target VARCHAR(120) NULL,
    ip VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS settings (
    k VARCHAR(60) PRIMARY KEY,
    v MEDIUMTEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS wa_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NULL,
    appointment_id INT NULL,
    user_id INT NULL,
    kind ENUM('lembrete','aviso','agendamento','profissional','confirmacao','remarcacao','exercicio','pagamento','teste','recebida','agente','manual') NOT NULL,
    direction ENUM('out','in') NOT NULL DEFAULT 'out',
    phone VARCHAR(30) NULL,
    body_enc MEDIUMTEXT NULL,
    status ENUM('enviado','erro','recebido') NOT NULL,
    wa_id VARCHAR(120) NULL,
    error VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id), INDEX (created_at), INDEX (appointment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS schedule_days (
    user_id INT NOT NULL,
    weekday TINYINT NOT NULL,
    start_time CHAR(5) NOT NULL DEFAULT '08:00',
    end_time CHAR(5) NOT NULL DEFAULT '18:00',
    period TINYINT NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, weekday, period)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS schedule_meta (
    user_id INT PRIMARY KEY,
    configured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS schedule_blocks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    block_date DATE NOT NULL,
    reason VARCHAR(120) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (user_id, block_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint VARCHAR(700) NOT NULL,
    endpoint_hash CHAR(64) NOT NULL UNIQUE,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    device VARCHAR(120) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    INDEX (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone_key CHAR(10) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL,
    contact_name VARCHAR(120) NULL,
    patient_id INT NULL,
    messages_enc MEDIUMTEXT NULL,
    status ENUM('ativo','humano') NOT NULL DEFAULT 'ativo',
    human_reason VARCHAR(255) NULL,
    human_until DATETIME NULL,
    lock_until DATETIME NULL,
    started_at DATETIME NULL,
    last_inbound_at DATETIME NULL,
    last_reply_at DATETIME NULL,
    turns INT NOT NULL DEFAULT 0,
    tokens_in BIGINT NOT NULL DEFAULT 0,
    tokens_out BIGINT NOT NULL DEFAULT 0,
    INDEX (status), INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_inbox (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    text_enc TEXT NOT NULL,
    processed TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (conversation_id, processed)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS crm_stages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    color VARCHAR(9) NOT NULL DEFAULT '#9c4422',
    position INT NOT NULL DEFAULT 0,
    auto_key VARCHAR(20) NULL UNIQUE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS crm_cards (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone_key CHAR(10) NULL UNIQUE,
    phone VARCHAR(30) NULL,
    name VARCHAR(160) NOT NULL,
    patient_id INT NULL,
    stage_id INT NOT NULL,
    prev_stage_id INT NULL,
    position DOUBLE NOT NULL DEFAULT 0,
    responsible_id INT NULL,
    tags VARCHAR(255) NULL,
    value DECIMAL(10,2) NULL,
    next_action VARCHAR(160) NULL,
    next_action_at DATE NULL,
    notes_enc MEDIUMTEXT NULL,
    source ENUM('whatsapp','manual') NOT NULL DEFAULT 'whatsapp',
    last_message_at DATETIME NULL,
    last_direction ENUM('in','out') NULL,
    manual_until DATETIME NULL,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (stage_id, position), INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS crm_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    card_id INT NOT NULL,
    user_id INT NULL,
    type VARCHAR(30) NOT NULL,
    text_enc TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (card_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_usage (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NULL,
    model VARCHAR(60) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    cache_read_tokens INT NOT NULL DEFAULT 0,
    cache_write_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ---------- Financeiro (fase 1) ----------
  // Regra de repasse por profissional (clínica fica com % ou valor fixo por sessão, + aluguel mensal opcional)
  `CREATE TABLE IF NOT EXISTS fin_rules (
    user_id INT PRIMARY KEY,
    mode ENUM('percent','fixed','none') NOT NULL DEFAULT 'none',
    value DECIMAL(10,2) NOT NULL DEFAULT 0,
    rent DECIMAL(10,2) NOT NULL DEFAULT 0,
    receipt_by ENUM('clinica','profissional') NOT NULL DEFAULT 'clinica',
    doc_enc TEXT NULL,
    updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS fin_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    kind ENUM('despesa','receita') NOT NULL DEFAULT 'despesa',
    active TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY (name, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Contas a pagar e a receber que não são de paciente (despesas, aluguel de sala, acertos)
  // owner_id NULL = clínica; preenchido = finanças próprias daquele(a) profissional
  `CREATE TABLE IF NOT EXISTS fin_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL,
    kind ENUM('pagar','receber') NOT NULL DEFAULT 'pagar',
    category_id INT NULL,
    description VARCHAR(255) NOT NULL,
    counterpart VARCHAR(160) NULL,
    amount DECIMAL(10,2) NOT NULL,
    due_date DATE NOT NULL,
    paid_at DATE NULL,
    method ENUM('pix','dinheiro','cartao','transferencia','boleto','outro') NULL,
    recurring_id INT NULL,
    rec_ym CHAR(7) NULL,
    settlement_id INT NULL,
    notes VARCHAR(500) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (owner_id, due_date), INDEX (settlement_id),
    UNIQUE KEY (recurring_id, rec_ym)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS fin_recurring (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL,
    kind ENUM('pagar','receber') NOT NULL DEFAULT 'pagar',
    category_id INT NULL,
    description VARCHAR(255) NOT NULL,
    counterpart VARCHAR(160) NULL,
    amount DECIMAL(10,2) NOT NULL,
    day TINYINT NOT NULL DEFAULT 10,
    start_ym CHAR(7) NOT NULL,
    end_ym CHAR(7) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Pacote de sessões pago adiantado: cada sessão realizada consome 1
  `CREATE TABLE IF NOT EXISTS fin_packages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    professional_id INT NULL,
    sessions_total SMALLINT NOT NULL,
    sessions_used SMALLINT NOT NULL DEFAULT 0,
    amount DECIMAL(10,2) NOT NULL,
    payment_id INT NULL,
    status ENUM('ativo','encerrado') NOT NULL DEFAULT 'ativo',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Acerto mensal clínica ↔ profissional (fotografia do cálculo no fechamento)
  `CREATE TABLE IF NOT EXISTS fin_settlements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    professional_id INT NOT NULL,
    ym CHAR(7) NOT NULL,
    net DECIMAL(10,2) NOT NULL,
    detail MEDIUMTEXT NULL,
    closed_by INT NULL,
    closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (professional_id, ym)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Anexos do financeiro (boletos, comprovantes): guardados no banco para não se perderem nas publicações
  `CREATE TABLE IF NOT EXISTS fin_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_id INT NULL,
    payment_id INT NULL,
    name VARCHAR(160) NOT NULL,
    mime VARCHAR(60) NOT NULL,
    size INT NOT NULL,
    data MEDIUMBLOB NOT NULL,
    uploaded_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (entry_id), INDEX (payment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS live_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    topics VARCHAR(200) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Extratos bancários importados (OFX/CSV) e suas transações para conciliação
  `CREATE TABLE IF NOT EXISTS fin_imports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL,
    bank VARCHAR(60) NULL,
    account VARCHAR(60) NULL,
    period_start DATE NULL,
    period_end DATE NULL,
    balance DECIMAL(12,2) NULL,
    file_name VARCHAR(160) NOT NULL,
    total INT NOT NULL DEFAULT 0,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (owner_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS fin_bank_tx (
    id INT AUTO_INCREMENT PRIMARY KEY,
    import_id INT NOT NULL,
    owner_key INT NOT NULL DEFAULT 0,
    acct_key VARCHAR(80) NOT NULL,
    fitid VARCHAR(100) NOT NULL,
    posted DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    memo VARCHAR(255) NULL,
    trn_type VARCHAR(20) NULL,
    status ENUM('pendente','conciliado','ignorado') NOT NULL DEFAULT 'pendente',
    match_type ENUM('payment','entry','created') NULL,
    match_id INT NULL,
    set_paid TINYINT(1) NOT NULL DEFAULT 0,
    done_by INT NULL,
    done_at DATETIME NULL,
    UNIQUE KEY (owner_key, acct_key, fitid),
    INDEX (import_id), INDEX (match_type, match_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Foto de perfil do WhatsApp dos contatos (cache; data NULL = contato sem foto pública)
  `CREATE TABLE IF NOT EXISTS wa_photos (
    phone_key CHAR(10) PRIMARY KEY,
    data MEDIUMBLOB NULL,
    mime VARCHAR(30) NULL,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Cópias de segurança feitas antes de limpar dados (área do usuário master)
  `CREATE TABLE IF NOT EXISTS maint_backups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(255) NOT NULL,
    tables_list VARCHAR(500) NOT NULL,
    rows_count INT NOT NULL DEFAULT 0,
    size INT NOT NULL DEFAULT 0,
    data LONGBLOB NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Histórico de backups (manual / diário / semanal / mensal) enviados ao Google Drive
  `CREATE TABLE IF NOT EXISTS backup_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    kind VARCHAR(20) NOT NULL,
    status ENUM('andamento','ok','erro') NOT NULL DEFAULT 'andamento',
    mode ENUM('juntos','separados') NOT NULL DEFAULT 'juntos',
    parts VARCHAR(60) NOT NULL,
    dest VARCHAR(20) NOT NULL DEFAULT 'drive',
    files TEXT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    error VARCHAR(500) NULL,
    created_by INT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    INDEX (kind, status, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Histórico de cada lançamento de paciente: quem criou, recebeu, confirmou, cancelou, lembretes
  `CREATE TABLE IF NOT EXISTS payment_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    payment_id INT NULL,
    appointment_id INT NULL,
    patient_id INT NULL,
    professional_id INT NULL,
    action VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NULL,
    detail VARCHAR(255) NULL,
    user_id INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (payment_id), INDEX (action, created_at), INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Monitoramento: erros do sistema (para detectar repetição) e alertas enviados ao suporte
  `CREATE TABLE IF NOT EXISTS app_errors (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    sig CHAR(40) NOT NULL,
    message VARCHAR(300) NOT NULL,
    path VARCHAR(200) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at), INDEX (sig, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS monitor_alerts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    alert_key VARCHAR(40) NOT NULL,
    kind ENUM('alerta','normalizado','teste') NOT NULL DEFAULT 'alerta',
    message VARCHAR(500) NOT NULL,
    channel VARCHAR(80) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Termos digitais (consentimento, contrato terapêutico, autorização de gravação/IA)
  `CREATE TABLE IF NOT EXISTS consent_templates (
    kind VARCHAR(20) PRIMARY KEY,
    title VARCHAR(160) NOT NULL,
    body MEDIUMTEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    active TINYINT(1) NOT NULL DEFAULT 1,
    updated_by INT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS consent_links (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    docs MEDIUMTEXT NOT NULL,
    status ENUM('pendente','aceito','recusado','cancelado') NOT NULL DEFAULT 'pendente',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    opened_at DATETIME NULL,
    decided_at DATETIME NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    signer_name VARCHAR(160) NULL,
    signer_cpf_enc TEXT NULL,
    signer_role ENUM('paciente','responsavel') NULL,
    signer_relation VARCHAR(60) NULL,
    INDEX (patient_id), INDEX (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Lista de espera inteligente (vagas que abrem com cancelamentos são oferecidas pelo WhatsApp)
  `CREATE TABLE IF NOT EXISTS waitlist (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NULL,
    name VARCHAR(160) NULL,
    phone VARCHAR(40) NULL,
    owner_id INT NULL,
    weekdays VARCHAR(20) NOT NULL DEFAULT '',
    periods VARCHAR(40) NOT NULL DEFAULT '',
    modality ENUM('qualquer','online','presencial') NOT NULL DEFAULT 'qualquer',
    from_date DATE NULL,
    until_date DATE NULL,
    notes VARCHAR(500) NULL,
    priority TINYINT NOT NULL DEFAULT 0,
    move_appt_id INT NULL,
    status ENUM('aguardando','agendado','removido','expirado') NOT NULL DEFAULT 'aguardando',
    created_via ENUM('equipe','agente') NOT NULL DEFAULT 'equipe',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL,
    appointment_id INT NULL,
    offers INT NOT NULL DEFAULT 0,
    last_offer_at DATETIME NULL,
    demo TINYINT NOT NULL DEFAULT 0,
    INDEX (status), INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS waitlist_slots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    starts_at DATETIME NOT NULL,
    duration_min INT NOT NULL DEFAULT 40,
    modality VARCHAR(12) NULL,
    source_appt_id INT NULL,
    status ENUM('aberta','preenchida','encerrada') NOT NULL DEFAULT 'aberta',
    reason VARCHAR(120) NULL,
    notified TINYINT NOT NULL DEFAULT 0,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL,
    appointment_id INT NULL,
    demo TINYINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_slot (owner_id, starts_at), INDEX (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS waitlist_offers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slot_id INT NOT NULL,
    waitlist_id INT NOT NULL,
    status ENUM('enviada','aceita','recusada','expirada','ocupada','falhou') NOT NULL DEFAULT 'enviada',
    modality VARCHAR(12) NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    answered_at DATETIME NULL,
    via VARCHAR(20) NULL,
    error VARCHAR(200) NULL,
    UNIQUE KEY uniq_offer (slot_id, waitlist_id), INDEX (status), INDEX (waitlist_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Painel de chamadas (TV da recepção)
  `CREATE TABLE IF NOT EXISTS tv_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    number INT NOT NULL DEFAULT 1,
    name VARCHAR(60) NULL,
    owner_id INT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_counters (
    day DATE NOT NULL,
    prefix VARCHAR(4) NOT NULL,
    n INT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, prefix)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_calls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NULL,
    ticket VARCHAR(12) NOT NULL,
    room_id INT NULL,
    owner_id INT NULL,
    called_by INT NULL,
    called_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (called_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_screens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(60) NOT NULL DEFAULT 'TV',
    token_hash CHAR(64) NOT NULL UNIQUE,
    pair_code CHAR(6) NULL,
    pair_expires DATETIME NULL,
    status ENUM('pendente','ativa') NOT NULL DEFAULT 'pendente',
    theme ENUM('escuro','claro') NOT NULL DEFAULT 'escuro',
    layout ENUM('mensagens','chamadas','midia') NOT NULL DEFAULT 'mensagens',
    rooms VARCHAR(200) NOT NULL DEFAULT '',
    last_seen DATETIME NULL,
    reload_at DATETIME NULL,
    paired_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (pair_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_media (
    id INT AUTO_INCREMENT PRIMARY KEY,
    kind ENUM('imagem','video') NOT NULL,
    mime VARCHAR(40) NOT NULL,
    size INT NOT NULL,
    sha CHAR(64) NOT NULL,
    name VARCHAR(160) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (sha)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_media_chunks (
    media_id INT NOT NULL,
    seq INT NOT NULL,
    data MEDIUMBLOB NOT NULL,
    PRIMARY KEY (media_id, seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(90) NOT NULL DEFAULT '',
    kind VARCHAR(20) NOT NULL DEFAULT 'servico',
    format ENUM('texto','imagem','video') NOT NULL DEFAULT 'texto',
    body VARCHAR(300) NULL,
    media_id INT NULL,
    qr_url VARCHAR(500) NULL,
    qr_label VARCHAR(60) NULL,
    qr_png MEDIUMTEXT NULL,
    start_date DATE NULL,
    end_date DATE NULL,
    weekdays VARCHAR(20) NOT NULL DEFAULT '',
    time_from TIME NULL,
    time_to TIME NULL,
    duration_sec INT NOT NULL DEFAULT 12,
    weight TINYINT NOT NULL DEFAULT 1,
    screens VARCHAR(200) NOT NULL DEFAULT '',
    active TINYINT NOT NULL DEFAULT 1,
    deleted TINYINT NOT NULL DEFAULT 0,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_campaign_stats (
    campaign_id INT NOT NULL,
    day DATE NOT NULL,
    plays INT NOT NULL DEFAULT 0,
    scans INT NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tv_sponsors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    contact VARCHAR(120) NULL,
    phone VARCHAR(40) NULL,
    email VARCHAR(160) NULL,
    doc VARCHAR(30) NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'Outros',
    tier ENUM('ouro','prata','bronze') NOT NULL DEFAULT 'prata',
    monthly DECIMAL(10,2) NOT NULL DEFAULT 0,
    due_day TINYINT NOT NULL DEFAULT 10,
    start_date DATE NULL,
    end_date DATE NULL,
    status ENUM('ativo','pausado','encerrado') NOT NULL DEFAULT 'ativo',
    to_finance TINYINT NOT NULL DEFAULT 1,
    recurring_id INT NULL,
    report_token VARCHAR(48) NOT NULL,
    notes VARCHAR(500) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (report_token)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Documentos psicológicos (Res. CFP 06/2019)
  `CREATE TABLE IF NOT EXISTS psy_docs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    author_id INT NULL,
    kind VARCHAR(20) NOT NULL,
    title VARCHAR(120) NOT NULL,
    body_enc MEDIUMTEXT NOT NULL,
    purpose VARCHAR(200) NULL,
    requester VARCHAR(160) NULL,
    appointment_id INT NULL,
    status ENUM('rascunho','emitido','cancelado') NOT NULL DEFAULT 'rascunho',
    hash CHAR(64) NULL,
    verify_code VARCHAR(12) NULL,
    signer_name VARCHAR(160) NULL,
    signer_crp VARCHAR(30) NULL,
    signed_at DATETIME NULL,
    share_token VARCHAR(48) NULL,
    share_expires DATETIME NULL,
    cancel_reason VARCHAR(200) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX (patient_id), UNIQUE KEY (verify_code), UNIQUE KEY (share_token)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Agendamento online pelo próprio paciente (confirmação por código no WhatsApp)
  `CREATE TABLE IF NOT EXISTS booking_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(48) NOT NULL UNIQUE,
    owner_id INT NOT NULL,
    starts_at DATETIME NOT NULL,
    duration_min INT NOT NULL DEFAULT 40,
    modality ENUM('online','presencial') NOT NULL DEFAULT 'online',
    name VARCHAR(160) NOT NULL,
    phone VARCHAR(40) NOT NULL,
    email VARCHAR(160) NULL,
    code_hash CHAR(64) NOT NULL,
    attempts TINYINT NOT NULL DEFAULT 0,
    status ENUM('codigo','agendado','expirado','bloqueado') NOT NULL DEFAULT 'codigo',
    appointment_id INT NULL,
    ip VARCHAR(64) NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (phone), INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_doc_usage (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    key_owner ENUM('clinica','profissional') NOT NULL,
    kind VARCHAR(20) NULL,
    model VARCHAR(60) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cost_usd DECIMAL(10,5) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // IA na sessão: gravação temporária (áudio criptografado, apagado após a transcrição), transcrição e rascunho até a revisão
  `CREATE TABLE IF NOT EXISTS session_rec (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    user_id INT NOT NULL,
    appointment_id INT NULL,
    source ENUM('gravacao','arquivo','texto') NOT NULL DEFAULT 'gravacao',
    status ENUM('gravando','processando','pronto','erro','salvo','descartado') NOT NULL DEFAULT 'gravando',
    step VARCHAR(40) NULL,
    mime VARCHAR(80) NULL,
    bytes INT NOT NULL DEFAULT 0,
    duration_s INT NOT NULL DEFAULT 0,
    transcript_enc MEDIUMTEXT NULL,
    draft_enc MEDIUMTEXT NULL,
    alerts_enc TEXT NULL,
    error VARCHAR(300) NULL,
    record_id INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (patient_id, status), INDEX (user_id, status), INDEX (status, updated_at),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS session_rec_chunks (
    rec_id INT NOT NULL,
    seq INT NOT NULL,
    data MEDIUMBLOB NOT NULL,
    PRIMARY KEY (rec_id, seq),
    FOREIGN KEY (rec_id) REFERENCES session_rec(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Portal do paciente: códigos de entrada (WhatsApp), links enviados pela clínica e acessos por aparelho
  `CREATE TABLE IF NOT EXISTS portal_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(48) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL,
    code_hash CHAR(64) NOT NULL,
    attempts TINYINT NOT NULL DEFAULT 0,
    ip VARCHAR(64) NULL,
    used_at DATETIME NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (phone, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS portal_links (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_by INT NULL,
    used_at DATETIME NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS portal_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token_hash CHAR(64) NOT NULL UNIQUE,
    patient_id INT NOT NULL,
    phone_key VARCHAR(20) NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    last_seen_at DATETIME NULL,
    revoked_at DATETIME NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Locação de espaços (consultórios, salas, auditórios)
  `CREATE TABLE IF NOT EXISTS rental_spaces (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    kind ENUM('consultorio','sala','auditorio','reuniao','outro') NOT NULL DEFAULT 'sala',
    capacity INT NULL,
    description VARCHAR(500) NULL,
    amenities VARCHAR(300) NULL,
    price_hour DECIMAL(10,2) NOT NULL DEFAULT 0,
    price_period DECIMAL(10,2) NOT NULL DEFAULT 0,
    price_day DECIMAL(10,2) NOT NULL DEFAULT 0,
    open_time CHAR(5) NOT NULL DEFAULT '07:00',
    close_time CHAR(5) NOT NULL DEFAULT '22:00',
    weekdays VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5,6',
    min_hours DECIMAL(4,1) NOT NULL DEFAULT 1,
    sort INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS rental_tenants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    doc_enc TEXT NULL,
    phone VARCHAR(40) NULL,
    email VARCHAR(160) NULL,
    profession VARCHAR(80) NULL,
    reg VARCHAR(40) NULL,
    notes VARCHAR(500) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS rental_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    space_id INT NOT NULL,
    weekdays VARCHAR(20) NOT NULL,
    start_time CHAR(5) NOT NULL,
    end_time CHAR(5) NOT NULL,
    monthly DECIMAL(10,2) NOT NULL,
    due_day TINYINT NOT NULL DEFAULT 10,
    start_date DATE NOT NULL,
    end_date DATE NULL,
    status ENUM('ativo','encerrado') NOT NULL DEFAULT 'ativo',
    recurring_id INT NULL,
    notes VARCHAR(500) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES rental_tenants(id),
    FOREIGN KEY (space_id) REFERENCES rental_spaces(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS rental_bookings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    space_id INT NOT NULL,
    tenant_id INT NULL,
    plan_id INT NULL,
    group_id INT NULL,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    unit ENUM('hora','periodo','diaria','plano') NOT NULL DEFAULT 'hora',
    qty DECIMAL(6,2) NOT NULL DEFAULT 0,
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    discount DECIMAL(10,2) NOT NULL DEFAULT 0,
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    status ENUM('reservada','confirmada','concluida','cancelada') NOT NULL DEFAULT 'reservada',
    entry_id INT NULL,
    notes VARCHAR(500) NULL,
    cancelled_at DATETIME NULL,
    cancel_reason VARCHAR(200) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (space_id, starts_at), INDEX (tenant_id), INDEX (plan_id, starts_at),
    FOREIGN KEY (space_id) REFERENCES rental_spaces(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Voz neural do painel de chamadas (MP3 gerado uma vez por frase/voz)
  `CREATE TABLE IF NOT EXISTS tts_cache (
    hash CHAR(64) PRIMARY KEY,
    engine VARCHAR(10) NOT NULL,
    data MEDIUMBLOB NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Cobrança online (Asaas): cada cobrança ligada a um lançamento de paciente
  `CREATE TABLE IF NOT EXISTS gw_charges (
    id INT AUTO_INCREMENT PRIMARY KEY,
    payment_id INT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'asaas',
    env VARCHAR(10) NOT NULL DEFAULT 'sandbox',
    gw_id VARCHAR(60) NOT NULL UNIQUE,
    customer_id VARCHAR(60) NULL,
    amount DECIMAL(10,2) NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    billing_type VARCHAR(20) NULL,
    invoice_url VARCHAR(500) NULL,
    net_value DECIMAL(10,2) NULL,
    paid_date DATE NULL,
    dup_alert TINYINT(1) NOT NULL DEFAULT 0,
    error VARCHAR(255) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (payment_id), INDEX (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Atendimento humano pelo WhatsApp da equipe: qual mensagem encaminhada pertence a qual conversa
  `CREATE TABLE IF NOT EXISTS nfse (
    id INT AUTO_INCREMENT PRIMARY KEY,
    payment_id INT NOT NULL,
    patient_id INT NOT NULL,
    provider VARCHAR(12) NOT NULL DEFAULT 'asaas',
    env VARCHAR(10) NULL,
    ext_id VARCHAR(60) NULL,
    status ENUM('pendente','agendada','emitida','erro','cancelando','cancelada') NOT NULL DEFAULT 'pendente',
    number VARCHAR(30) NULL,
    value DECIMAL(10,2) NOT NULL,
    description VARCHAR(500) NULL,
    pdf_url VARCHAR(500) NULL,
    xml_url VARCHAR(500) NULL,
    error VARCHAR(255) NULL,
    created_by INT NULL,
    canceled_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    issued_at DATETIME NULL,
    canceled_at DATETIME NULL,
    delivered_at DATETIME NULL,
    INDEX (payment_id), INDEX (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS insurers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    active TINYINT(1) NOT NULL DEFAULT 0,
    ans_code VARCHAR(20) NULL,
    provider_code VARCHAR(40) NULL,
    credential ENUM('clinica','profissional') NOT NULL DEFAULT 'clinica',
    requires_auth TINYINT(1) NOT NULL DEFAULT 1,
    sessions_per_auth SMALLINT NOT NULL DEFAULT 10,
    auth_days SMALLINT NOT NULL DEFAULT 60,
    requires_signature TINYINT(1) NOT NULL DEFAULT 1,
    requires_token TINYINT(1) NOT NULL DEFAULT 0,
    copay_mode ENUM('nenhuma','percentual','fixo') NOT NULL DEFAULT 'nenhuma',
    copay_value DECIMAL(10,2) NOT NULL DEFAULT 0,
    close_day TINYINT NULL,
    pay_days SMALLINT NOT NULL DEFAULT 30,
    send_via ENUM('portal','webservice','papel') NOT NULL DEFAULT 'portal',
    portal_url VARCHAR(300) NULL,
    phone VARCHAR(40) NULL,
    notes VARCHAR(1000) NULL,
    updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS insurer_procs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    insurer_id INT NOT NULL,
    tuss_code VARCHAR(20) NULL,
    description VARCHAR(160) NOT NULL,
    value DECIMAL(10,2) NOT NULL DEFAULT 0,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    INDEX (insurer_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS patient_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    insurer_id INT NOT NULL,
    card_enc TEXT NULL,
    plan_name VARCHAR(80) NULL,
    holder_name VARCHAR(160) NULL,
    valid_until DATE NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS insurer_auths (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    plan_id INT NOT NULL,
    proc_id INT NULL,
    password VARCHAR(40) NULL,
    sessions_total SMALLINT NOT NULL,
    valid_from DATE NOT NULL,
    valid_until DATE NOT NULL,
    status ENUM('ativa','cancelada') NOT NULL DEFAULT 'ativa',
    notes VARCHAR(300) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (plan_id), INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tiss_batches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    insurer_id INT NOT NULL,
    professional_id INT NULL,
    lot_number VARCHAR(12) NOT NULL,
    competence CHAR(7) NOT NULL,
    status ENUM('gerado','enviado','cancelado') NOT NULL DEFAULT 'gerado',
    guides SMALLINT NOT NULL DEFAULT 0,
    total DECIMAL(12,2) NOT NULL DEFAULT 0,
    xml MEDIUMTEXT NULL,
    hash CHAR(32) NULL,
    protocol VARCHAR(30) NULL,
    sent_at DATETIME NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    canceled_at DATETIME NULL,
    INDEX (insurer_id, competence)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tiss_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id INT NOT NULL,
    appointment_id INT NOT NULL,
    guide_number VARCHAR(20) NOT NULL,
    value DECIMAL(10,2) NOT NULL,
    INDEX (batch_id), INDEX (appointment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Convênios (fase 3): demonstrativos de retorno importados e recursos de glosa
  `CREATE TABLE IF NOT EXISTS tiss_demos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    insurer_id INT NULL,
    kind ENUM('analise','pagamento') NOT NULL,
    number VARCHAR(20) NULL,
    issued DATE NULL,
    pay_date DATE NULL,
    total DECIMAL(12,2) NULL,
    file_name VARCHAR(160) NULL,
    xml MEDIUMTEXT NULL,
    summary TEXT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (insurer_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tiss_appeals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id INT NOT NULL,
    number VARCHAR(20) NOT NULL,
    status ENUM('rascunho','enviado','respondido') NOT NULL DEFAULT 'rascunho',
    total DECIMAL(12,2) NOT NULL DEFAULT 0,
    xml MEDIUMTEXT NULL,
    hash CHAR(32) NULL,
    protocol VARCHAR(30) NULL,
    sent_at DATETIME NULL,
    answered_at DATETIME NULL,
    recovered DECIMAL(12,2) NULL,
    received_at DATE NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (batch_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Convênios (fase 4): chamadas aos webservices TISS das operadoras e pedidos de autorização
  `CREATE TABLE IF NOT EXISTS tiss_ws_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    insurer_id INT NOT NULL,
    service VARCHAR(30) NOT NULL,
    ref VARCHAR(40) NULL,
    ok TINYINT(1) NULL,
    http_status SMALLINT NULL,
    error VARCHAR(500) NULL,
    request MEDIUMTEXT NULL,
    response MEDIUMTEXT NULL,
    user_id INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (insurer_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tiss_auth_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    plan_id INT NOT NULL,
    proc_id INT NULL,
    guide_number VARCHAR(20) NOT NULL,
    op_guide VARCHAR(20) NULL,
    sessions SMALLINT NOT NULL,
    status ENUM('enviado','analise','autorizado','negado','erro') NOT NULL DEFAULT 'enviado',
    auth_id INT NULL,
    message VARCHAR(500) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX (patient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS react_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    owner_id INT NULL,
    channel VARCHAR(12) NOT NULL,
    sent_at DATETIME NOT NULL,
    by_user INT NULL,
    auto TINYINT(1) NOT NULL DEFAULT 0,
    appt_mark INT NOT NULL DEFAULT 0,
    INDEX (patient_id, sent_at), INDEX (sent_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS icp_cloud_sessions (
    state VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    doc_id INT NOT NULL,
    provider VARCHAR(20) NOT NULL,
    verifier TEXT NOT NULL,
    created BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS icp_cloud_tokens (
    user_id INT NOT NULL,
    provider VARCHAR(20) NOT NULL,
    token_enc TEXT NOT NULL,
    expires BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS psy_doc_files (
    doc_id INT PRIMARY KEY,
    base MEDIUMBLOB NULL,
    signed MEDIUMBLOB NULL,
    updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tele_rooms (
    appt_id INT PRIMARY KEY,
    owner_id INT NULL,
    pac_name VARCHAR(80) NULL,
    admitted TINYINT(1) NOT NULL DEFAULT 0,
    pro_conn VARCHAR(24) NULL,
    pro_seen BIGINT NOT NULL DEFAULT 0,
    pac_conn VARCHAR(24) NULL,
    pac_seen BIGINT NOT NULL DEFAULT 0,
    pac_left BIGINT NOT NULL DEFAULT 0,
    waiting_since BIGINT NULL,
    INDEX (owner_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tele_signals (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    appt_id INT NOT NULL,
    to_role ENUM('pro','pac') NOT NULL,
    msg MEDIUMTEXT NOT NULL,
    created BIGINT NOT NULL,
    INDEX (appt_id, to_role, id), INDEX (created)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS user_fiscal (
    user_id INT PRIMARY KEY,
    kind ENUM('pf','pj') NOT NULL DEFAULT 'pf',
    full_name VARCHAR(160) NULL,
    cpf_enc TEXT NULL,
    address VARCHAR(200) NULL,
    city VARCHAR(80) NULL,
    nfse_cfg TEXT NULL,
    updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS scale_apps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    owner_id INT NULL,
    instrument VARCHAR(20) NOT NULL,
    status ENUM('pendente','respondido','cancelado') NOT NULL DEFAULT 'pendente',
    via VARCHAR(12) NOT NULL DEFAULT 'link',
    answers_enc TEXT NULL,
    result_enc TEXT NULL,
    alert TINYINT(1) NOT NULL DEFAULT 0,
    alert_seen_at DATETIME NULL,
    alert_seen_by INT NULL,
    sent_at DATETIME NULL,
    opened_at DATETIME NULL,
    answered_at DATETIME NULL,
    expires_at DATETIME NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id, instrument), INDEX (status), INDEX (alert)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS scale_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    instrument VARCHAR(20) NOT NULL,
    every_days SMALLINT NOT NULL,
    next_at DATETIME NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (patient_id, instrument), INDEX (active, next_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS surveys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    appointment_id INT NULL,
    owner_id INT NULL,
    channel VARCHAR(12) NOT NULL DEFAULT 'whatsapp',
    sent_at DATETIME NULL,
    send_error VARCHAR(255) NULL,
    opened_at DATETIME NULL,
    answered_at DATETIME NULL,
    score TINYINT NULL,
    comment_enc TEXT NULL,
    review_clicked_at DATETIME NULL,
    followup_at DATETIME NULL,
    followup_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (patient_id), INDEX (answered_at), INDEX (sent_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notify_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NULL,
    patient_id INT NULL,
    channel ENUM('email','sms') NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'lembrete',
    dest_enc TEXT NULL,
    status ENUM('enviado','erro') NOT NULL,
    error VARCHAR(255) NULL,
    provider_id VARCHAR(120) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (appointment_id), INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS relay_msgs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conv_id INT NOT NULL,
    op_key VARCHAR(20) NOT NULL,
    wa_id VARCHAR(80) NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (conv_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS site_wa_clicks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    origin VARCHAR(40) NOT NULL DEFAULT 'site',
    target ENUM('assistente','doutora') NOT NULL,
    reason VARCHAR(40) NULL,
    INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Rascunho da sessão em andamento (salvo sozinho enquanto a profissional escreve; um por profissional e paciente)
  `CREATE TABLE IF NOT EXISTS record_drafts (
    user_id INT NOT NULL,
    patient_id INT NOT NULL,
    appointment_id INT NULL,
    data_enc MEDIUMTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, patient_id),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    ip VARCHAR(64) NOT NULL,
    attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (ip, attempted_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

// Colunas adicionadas depois da primeira versão (migração segura no banco em produção).
const COLUMNS = [
  ['users', 'role', "ENUM('admin','psicologo','secretaria','financeiro') NOT NULL DEFAULT 'admin' AFTER email"],
  ['users', 'active', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER role'],
  ['users', 'crp', 'VARCHAR(30) NULL AFTER name'],
  ['users', 'phone', 'VARCHAR(40) NULL AFTER crp'],
  ['users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['users', 'session_version', 'INT NOT NULL DEFAULT 1'],
  ['users', 'last_login_at', 'DATETIME NULL'],
  ['users', 'updated_at', 'DATETIME NULL ON UPDATE CURRENT_TIMESTAMP'],
  ['patients', 'owner_id', 'INT NULL AFTER id'],
  ['records', 'author_id', 'INT NULL AFTER appointment_id'],
  // Google Agenda por profissional
  ['users', 'google_refresh_enc', 'TEXT NULL'],
  ['users', 'google_email', 'VARCHAR(190) NULL'],
  ['users', 'google_calendar_id', 'VARCHAR(255) NULL'],
  ['users', 'google_meet', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['users', 'google_title', "ENUM('iniciais','primeiro_nome','nome_completo') NOT NULL DEFAULT 'iniciais'"],
  ['users', 'google_connected_at', 'DATETIME NULL'],
  ['users', 'google_error', 'VARCHAR(255) NULL'],
  ['users', 'ical_token_hash', 'CHAR(64) NULL'],
  ['appointments', 'google_event_id', 'VARCHAR(255) NULL'],
  ['appointments', 'google_cal', 'VARCHAR(255) NULL'],
  ['appointments', 'google_owner_id', 'INT NULL'],
  ['appointments', 'google_synced_at', 'DATETIME NULL'],
  ['appointments', 'google_error', 'VARCHAR(255) NULL'],
  // WhatsApp (Evolution API)
  ['patients', 'whatsapp_optin', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['patients', 'responsible_name', 'VARCHAR(160) NULL'],
  ['users', 'title', 'VARCHAR(10) NULL'],
  ['payments', 'professional_id', 'INT NULL'],
  ['payments', 'receiver', "ENUM('clinica','profissional') NOT NULL DEFAULT 'clinica'"],
  ['payments', 'issuer', "ENUM('clinica','profissional') NULL"],
  ['nfse', 'issuer_user_id', 'INT NULL'],
  // certificado digital A1 (ICP-Brasil) do(a) profissional
  ['users', 'cert_pfx_enc', 'MEDIUMTEXT NULL'],
  ['users', 'cert_pass_enc', 'TEXT NULL'],
  ['users', 'cert_name', 'VARCHAR(160) NULL'],
  ['users', 'cert_cpf_enc', 'TEXT NULL'],
  ['users', 'cert_issuer', 'VARCHAR(160) NULL'],
  ['users', 'cert_serial', 'VARCHAR(64) NULL'],
  ['users', 'cert_valid_to', 'DATETIME NULL'],
  // PDF do documento psicológico e a versão assinada com ICP-Brasil
  ['psy_docs', 'icp_via', "ENUM('a1','externo','nuvem') NULL"],
  ['psy_docs', 'icp_provider', 'VARCHAR(20) NULL'],
  ['users', 'cloud_provider', 'VARCHAR(20) NULL'],
  ['patients', 'react_optin', 'TINYINT(1) NOT NULL DEFAULT 1'],
  // convênios
  ['payments', 'insurer_id', 'INT NULL'],
  ['appointments', 'plan_id', 'INT NULL'],
  ['appointments', 'auth_id', 'INT NULL'],
  ['appointments', 'guide_signed_at', 'DATETIME NULL'],
  ['appointments', 'guide_token', 'VARCHAR(40) NULL'],
  ['patients', 'default_plan_id', 'INT NULL'],
  ['insurers', 'copay_where', "ENUM('operadora','prestador') NOT NULL DEFAULT 'operadora'"],
  ['insurers', 'tiss_version', "VARCHAR(10) NOT NULL DEFAULT '4.03.00'"],
  ['insurers', 'guide_mode', "ENUM('sessao','autorizacao') NOT NULL DEFAULT 'sessao'"],
  ['insurers', 'next_lot', 'INT NOT NULL DEFAULT 1'],
  ['insurers', 'next_guide', 'INT NOT NULL DEFAULT 1'],
  ['insurers', 'appeal_days', 'SMALLINT NOT NULL DEFAULT 30'],
  ['insurers', 'next_appeal', 'INT NOT NULL DEFAULT 1'],
  ['tiss_batches', 'analyzed_at', 'DATE NULL'],
  ['tiss_batches', 'released', 'DECIMAL(12,2) NULL'],
  ['tiss_batches', 'glosa', 'DECIMAL(12,2) NULL'],
  ['tiss_batches', 'paid_at', 'DATE NULL'],
  ['tiss_batches', 'paid_net', 'DECIMAL(12,2) NULL'],
  ['tiss_batches', 'demo_id', 'INT NULL'],
  ['tiss_items', 'op_guide', 'VARCHAR(20) NULL'],
  ['tiss_items', 'released', 'DECIMAL(10,2) NULL'],
  ['tiss_items', 'glosa', 'DECIMAL(10,2) NULL'],
  ['tiss_items', 'glosa_code', 'VARCHAR(4) NULL'],
  ['tiss_items', 'glosa_note', 'VARCHAR(500) NULL'],
  ['tiss_items', 'paid', 'DECIMAL(10,2) NULL'],
  ['tiss_items', 'appeal_id', 'INT NULL'],
  ['tiss_items', 'appeal_value', 'DECIMAL(10,2) NULL'],
  ['tiss_items', 'appeal_text', 'VARCHAR(500) NULL'],
  ['tiss_items', 'recovered', 'DECIMAL(10,2) NULL'],
  ['payments', 'billed_amount', 'DECIMAL(10,2) NULL'],
  ['insurers', 'ws_urls', 'TEXT NULL'],
  ['insurers', 'ws_login', 'VARCHAR(20) NULL'],
  ['insurers', 'ws_pass_enc', 'TEXT NULL'],
  ['insurers', 'ws_pass_mode', "ENUM('md5','texto') NOT NULL DEFAULT 'md5'"],
  ['insurers', 'ws_cert_enc', 'MEDIUMTEXT NULL'],
  ['insurers', 'ws_cert_pass_enc', 'TEXT NULL'],
  ['insurers', 'ws_cert_name', 'VARCHAR(200) NULL'],
  ['patient_plans', 'elig_at', 'DATETIME NULL'],
  ['patient_plans', 'elig_ok', 'TINYINT(1) NULL'],
  ['patient_plans', 'elig_msg', 'VARCHAR(500) NULL'],
  ['tiss_batches', 'ws_sent', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['tiss_batches', 'op_status', 'TINYINT NULL'],
  ['tiss_batches', 'op_status_at', 'DATETIME NULL'],
  ['psy_docs', 'icp_name', 'VARCHAR(160) NULL'],
  ['psy_docs', 'icp_cpf_enc', 'TEXT NULL'],
  ['psy_docs', 'icp_issuer', 'VARCHAR(160) NULL'],
  ['psy_docs', 'icp_signed_at', 'DATETIME NULL'],
  ['payments', 'clinic_share', 'DECIMAL(10,2) NULL'],
  ['payments', 'sessions', 'SMALLINT NOT NULL DEFAULT 1'],
  ['payments', 'package_id', 'INT NULL'],
  ['payments', 'settlement_id', 'INT NULL'],
  ['patients', 'pay_to', "ENUM('clinica','profissional') NOT NULL DEFAULT 'clinica'"],
  ['appointments', 'package_id', 'INT NULL'],
  ['payments', 'origin', "ENUM('sessao','falta','pacote','avulso','convenio') NOT NULL DEFAULT 'avulso'"],
  ['payments', 'charged_at', 'DATETIME NULL'],
  ['fin_rules', 'pix_type', "ENUM('cpf','cnpj','telefone','email','aleatoria') NULL"],
  ['fin_rules', 'pix_key', 'VARCHAR(140) NULL'],
  ['patients', 'payer_name', 'VARCHAR(160) NULL'],
  ['patients', 'payer_cpf_enc', 'TEXT NULL'],
  ['users', 'photo', 'MEDIUMBLOB NULL'],
  ['users', 'photo_v', 'INT NOT NULL DEFAULT 0'],
  ['patients', 'responsible_phone', 'VARCHAR(40) NULL'],
  ['appointments', 'wa_reminder_at', 'DATETIME NULL'],
  ['appointments', 'wa_reply', "ENUM('confirmou','remarcar') NULL"],
  ['appointments', 'wa_reply_at', 'DATETIME NULL'],
  ['appointments', 'wa_reschedule_done', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['appointments', 'wa_reminder2_at', 'DATETIME NULL'],
  ['appointments', 'patient_note', 'VARCHAR(500) NULL'],
  ['appointments', 'created_by', 'INT NULL'],
  ['agent_conversations', 'last_slots', 'TEXT NULL'],
  ['users', 'is_master', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['users', 'photo_orig', 'MEDIUMBLOB NULL'],
  ['appointments', 'arrived_at', 'DATETIME NULL'],
  ['appointments', 'started_at', 'DATETIME NULL'],
  ['appointments', 'finished_at', 'DATETIME NULL'],
  ['appointments', 'flow_by', 'INT NULL'],
  ['payments', 'received_by', 'INT NULL'],
  ['payments', 'received_at', 'DATETIME NULL'],
  ['users', 'demo', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['patients', 'demo', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['crm_cards', 'demo', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['fin_entries', 'demo', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['fin_recurring', 'demo', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['schedule_days', 'period', 'TINYINT NOT NULL DEFAULT 1'],
  ['schedule_meta', 'session_min', 'SMALLINT NULL'],
  ['schedule_meta', 'interval_min', 'SMALLINT NULL'],
  ['users', 'signature_png', 'MEDIUMTEXT NULL'],
  ['users', 'ai_key_enc', 'TEXT NULL'],
  ['users', 'ai_provider', 'VARCHAR(20) NULL'],
  ['users', 'ai_model', 'VARCHAR(120) NULL'],
  ['users', 'ai_base_url', 'VARCHAR(300) NULL'],
  ['patients', 'ai_rec_paper_at', 'DATETIME NULL'],
  ['patients', 'ai_rec_revoked_at', 'DATETIME NULL'],
  ['patients', 'portal_last_at', 'DATETIME NULL'],
  ['payments', 'informed_at', 'DATETIME NULL'],
  ['rental_tenants', 'user_id', 'INT NULL'],
  ['users', 'attends', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['users', 'modalities', "VARCHAR(30) NOT NULL DEFAULT 'online,presencial'"],
  ['patients', 'gw_customer', 'VARCHAR(80) NULL'],
  ['agent_conversations', 'relay_started_at', 'DATETIME NULL'],
  ['appointments', 'email_reminder_at', 'DATETIME NULL'],
  ['appointments', 'sms_reminder_at', 'DATETIME NULL'],
  ['appointments', 'reply_channel', 'VARCHAR(10) NULL'],
  ['patients', 'email_optin', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['patients', 'sms_optin', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['patients', 'survey_optin', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['payments', 'rs_issued_at', 'DATETIME NULL'],
  ['appointments', 'tele_provider', 'VARCHAR(10) NULL'],
  ['appointments', 'tele_used', 'VARCHAR(10) NULL'],
  ['appointments', 'tele_error', 'VARCHAR(255) NULL'],
  ['appointments', 'zoom_meeting_id', 'VARCHAR(40) NULL'],
  ['users', 'tele_provider', 'VARCHAR(10) NULL'],
  ['users', 'zoom_link', 'VARCHAR(500) NULL'],
  ['users', 'zoom_email', 'VARCHAR(190) NULL'],
  ['payments', 'rs_issued_by', 'INT NULL'],
  ['patients', 'birthday_optin', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['patients', 'birthday_sent_year', 'SMALLINT NULL'],
  ['gw_charges', 'pix_id', 'VARCHAR(40) NULL'],
  ['agent_conversations', 'human_note', 'TEXT NULL'],
  ['tv_campaigns', 'sponsor_id', 'INT NULL'],
  ['tv_campaigns', 'position', 'INT NULL'],
  ['tv_campaigns', 'show_title', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['tv_campaigns', 'approval', "ENUM('aprovada','pendente','recusada') NOT NULL DEFAULT 'aprovada'"],
  ['tv_campaigns', 'approved_by', 'INT NULL'],
  ['tv_campaigns', 'approved_at', 'DATETIME NULL'],
  ['tv_campaigns', 'reject_reason', 'VARCHAR(200) NULL'],
  ['appointments', 'ticket', 'VARCHAR(12) NULL'],
  // Prontuário: texto formatado (editor), demanda trazida, hipótese diagnóstica e CID-10/CID-11
  ['records', 'format', "ENUM('texto','html') NOT NULL DEFAULT 'texto'"],
  ['records', 'demand_enc', 'TEXT NULL'],
  ['records', 'diagnosis_enc', 'TEXT NULL'],
  // Sessão: começar a gravar sozinho ao iniciar (preferência de cada profissional)
  ['users', 'auto_rec', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['appointments', 'ticket_type', 'CHAR(1) NULL'],
  ['appointments', 'called_at', 'DATETIME NULL'],
  ['appointments', 'call_count', 'INT NOT NULL DEFAULT 0'],
  ['appointments', 'room_id', 'INT NULL'],
  ['appointments', 'created_via', "ENUM('sistema','agente','lista_espera','online') NOT NULL DEFAULT 'sistema'"],
];

export async function getSetting(k) {
  const row = await one('SELECT v FROM settings WHERE k = ?', [k]);
  return row ? row.v : null;
}
export async function setSetting(k, v) {
  await q('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
}

export async function migrate() {
  for (const sql of SCHEMA) await q(sql);
  for (const [table, column, def] of COLUMNS) {
    const exists = await one(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
    if (!exists) await q(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  // Tipo “aviso” (lembrete curto) acrescentado depois: amplia o ENUM se a tabela já existia.
  const kind = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wa_messages' AND COLUMN_NAME = 'kind'");
  if (kind && !kind.t.includes("'reativacao'")) {
    await q("ALTER TABLE wa_messages MODIFY kind ENUM('lembrete','aviso','agendamento','profissional','confirmacao','remarcacao','exercicio','pagamento','cobranca','teste','recebida','agente','manual','lista_espera','aniversario','pesquisa','reativacao') NOT NULL");
  }
  // Escala com até 3 blocos por dia (manhã, tarde, noite): a chave passa a incluir o bloco
  if (!(await one("SELECT 1 x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedule_days' AND INDEX_NAME = 'PRIMARY' AND COLUMN_NAME = 'period'"))) {
    await q('ALTER TABLE schedule_days DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, weekday, period)');
  }
  const tvl = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tv_screens' AND COLUMN_NAME = 'layout'");
  if (tvl && !tvl.t.includes("'midia'")) await q("ALTER TABLE tv_screens MODIFY layout ENUM('mensagens','chamadas','midia') NOT NULL DEFAULT 'mensagens'");
  const cv = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appointments' AND COLUMN_NAME = 'created_via'");
  if (cv && !cv.t.includes("'online'")) await q("ALTER TABLE appointments MODIFY created_via ENUM('sistema','agente','lista_espera','online') NOT NULL DEFAULT 'sistema'");
  // Motivos antigos gravados com o erro técnico da API
  await q("UPDATE agent_conversations SET human_reason = 'Sem créditos na conta da Anthropic' WHERE human_reason LIKE '%credit balance%'");
  // Tratamento da Dra. Lorrainy (o nome não permite deduzir com segurança).
  await q("UPDATE users SET title = 'Dra.' WHERE title IS NULL AND name LIKE 'Lorrainy%'");
  // Forma “boleto” nos recebimentos
  const pm = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'method'");
  // Uma cobrança por sessão (sessão ou falta): impede lançamento duplicado mesmo com dois cliques simultâneos
  if (!(await one("SELECT 1 x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'uniq_appt_origin'"))) {
    try { await q('ALTER TABLE payments ADD UNIQUE KEY uniq_appt_origin (appointment_id, origin)'); } catch (e) { console.error('índice único de cobranças não criado (há duplicadas antigas):', e.message); }
  }
  const ast = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appointments' AND COLUMN_NAME = 'status'");
  if (ast && !ast.t.includes("'aguardando'")) await q("ALTER TABLE appointments MODIFY status ENUM('agendada','confirmada','aguardando','em_atendimento','realizada','falta','cancelada') NOT NULL DEFAULT 'agendada'");
  const po = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'origin'");
  if (po && !po.t.includes("'convenio'")) await q("ALTER TABLE payments MODIFY origin ENUM('sessao','falta','pacote','avulso','convenio') NOT NULL DEFAULT 'avulso'");
  const tb = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tiss_batches' AND COLUMN_NAME = 'status'");
  if (tb && !tb.t.includes("'pago'")) await q("ALTER TABLE tiss_batches MODIFY status ENUM('gerado','enviado','analisado','pago','cancelado') NOT NULL DEFAULT 'gerado'");
  const bm = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fin_bank_tx' AND COLUMN_NAME = 'match_type'");
  if (bm && !bm.t.includes("'tiss'")) await q("ALTER TABLE fin_bank_tx MODIFY match_type ENUM('payment','entry','created','tiss') NULL");
  // convênios mais comuns já na lista (a clínica liga os que tem contrato)
  for (const n of ['Unimed', 'Bradesco Saúde', 'Amil', 'SulAmérica', 'Cassi', 'GEAP', 'Saúde Caixa', 'NotreDame Intermédica', 'Porto Seguro Saúde', 'Allianz Saúde', 'Postal Saúde', 'Ipasgo', 'AFFEGO', 'Mais Saúde', 'CAESAN/Saneago', 'Saúde Itaú']) await q('INSERT IGNORE INTO insurers (name) VALUES (?)', [n]);
  const iv = await one("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'psy_docs' AND COLUMN_NAME = 'icp_via'");
  if (iv && !iv.t.includes("'nuvem'")) await q("ALTER TABLE psy_docs MODIFY icp_via ENUM('a1','externo','nuvem') NULL");
  if (pm && !pm.t.includes("'boleto'")) await q("ALTER TABLE payments MODIFY method ENUM('pix','dinheiro','cartao','transferencia','boleto','outro') NULL");
  // Financeiro: categorias padrão e profissional responsável nos lançamentos antigos
  const CATS = ['Aluguel', 'Condomínio', 'Energia', 'Água', 'Internet e telefone', 'Anuidade do CRP', 'Supervisão', 'Cursos e formação', 'Sistemas e assinaturas', 'Marketing', 'Material de consumo', 'Impostos e taxas', 'Contador', 'Repasse a profissionais', 'Outras despesas'];
  for (const c of CATS) await q("INSERT IGNORE INTO fin_categories (name, kind) VALUES (?, 'despesa')", [c]);
  for (const c of ['Aluguel de sala', 'Acerto de profissional', 'Patrocínio', 'Outras receitas']) await q("INSERT IGNORE INTO fin_categories (name, kind) VALUES (?, 'receita')", [c]);
  await q('UPDATE payments x JOIN patients p ON p.id = x.patient_id SET x.professional_id = p.owner_id WHERE x.professional_id IS NULL');
  await q("UPDATE payments SET origin = 'sessao' WHERE origin = 'avulso' AND appointment_id IS NOT NULL");
  await q("UPDATE payments SET origin = 'pacote' WHERE origin = 'avulso' AND package_id IS NOT NULL");
  // Pacientes antigos ficam sob a responsabilidade da primeira administradora.
  const admin = await one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (admin) {
    await q('UPDATE patients SET owner_id = ? WHERE owner_id IS NULL', [admin.id]);
    await q('UPDATE records SET author_id = ? WHERE author_id IS NULL', [admin.id]);
  }
  // Usuário master (área de manutenção de dados): se ninguém for master, a primeira administradora ativa é.
  if (!(await one('SELECT id FROM users WHERE is_master = 1 AND active = 1 LIMIT 1'))) {
    const m = await one("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND demo = 0 ORDER BY id LIMIT 1");
    if (m) await q('UPDATE users SET is_master = 1 WHERE id = ?', [m.id]);
  }
}

export async function audit(req, action, target = null) {
  try {
    await q('INSERT INTO audit_log (user_id, action, target, ip) VALUES (?,?,?,?)', [
      req.user ? req.user.id : null, action, target, req.ip,
    ]);
  } catch (e) {
    console.error('audit', e.message);
  }
}
