// Catálogo das folhas dos três cadernos + versões interativas (formulários) para o portal do paciente.
export const BOOKS = {
  v1: { title: 'Vol. 1 · Ferramentas da TCC', dir: 'folhas' },
  v2: { title: 'Vol. 2 · Caderno de exercícios ilustrado', dir: 'folhas-ilustradas' },
  v3: { title: 'Vol. 3 · Caderno temático', dir: 'folhas-tematicas' },
};

const LIST = {
  v1: [
    ['01-meus-objetivos-na-terapia', 'Meus objetivos na terapia'],
    ['02-o-modelo-cognitivo', 'O modelo cognitivo'],
    ['03-registro-de-pensamentos', 'Registro de pensamentos'],
    ['04-armadilhas-do-pensamento', 'Armadilhas do pensamento'],
    ['05-questionando-um-pensamento', 'Questionando um pensamento'],
    ['06-seta-descendente', 'Seta descendente'],
    ['07-diario-de-emocoes', 'Diário de emoções'],
    ['08-monitoramento-de-atividades', 'Monitoramento de atividades'],
    ['09-agenda-de-atividades', 'Agenda de atividades'],
    ['10-escada-de-exposicao', 'Escada de exposição'],
    ['11-experimento-comportamental', 'Experimento comportamental'],
    ['12-resolucao-de-problemas', 'Resolução de problemas'],
    ['13-pros-e-contras', 'Prós e contras'],
    ['14-cartoes-de-enfrentamento', 'Cartões de enfrentamento'],
    ['15-registro-de-conquistas', 'Registro de conquistas'],
    ['16-plano-de-prevencao-de-recaida', 'Plano de prevenção de recaída'],
    ['17-anotacoes-da-sessao', 'Anotações da sessão (uso da psicóloga)'],
  ],
  v2: [
    ['01-termometro-das-emocoes', 'Termômetro das emoções'],
    ['02-roda-das-emocoes', 'Roda das emoções'],
    ['03-mapa-do-corpo', 'Mapa do corpo'],
    ['04-o-iceberg-das-emocoes', 'O iceberg das emoções'],
    ['05-pizza-da-responsabilidade', 'Pizza da responsabilidade'],
    ['06-grafico-do-humor', 'Gráfico do humor'],
    ['07-a-onda-da-ansiedade', 'A onda da ansiedade'],
    ['08-circulos-de-controle', 'Círculos de controle'],
    ['09-minha-bateria-de-energia', 'Minha bateria de energia'],
    ['10-a-balanca-da-decisao', 'A balança da decisão'],
    ['11-pensamentos-como-nuvens', 'Pensamentos como nuvens'],
    ['12-roda-da-vida', 'Roda da vida'],
    ['13-alvo-dos-valores', 'Alvo dos valores'],
    ['14-linha-do-tempo', 'Linha do tempo'],
    ['15-montanha-das-metas', 'Montanha das metas'],
    ['16-o-semaforo-das-emocoes', 'O semáforo das emoções'],
    ['17-kit-de-calma-dos-cinco-sentidos', 'Kit de calma dos cinco sentidos'],
    ['18-o-relogio-do-meu-dia', 'O relógio do meu dia'],
  ],
  v3: [
    ['01-plano-para-a-crise-de-ansiedade', 'Plano para a crise de ansiedade'],
    ['02-o-tempo-da-preocupacao', 'O tempo da preocupação'],
    ['03-relaxamento-muscular-progressivo', 'Relaxamento muscular progressivo'],
    ['04-cardapio-de-atividades', 'Cardápio de atividades'],
    ['05-a-regra-dos-5-minutos', 'A regra dos 5 minutos'],
    ['06-saindo-da-ruminacao', 'Saindo da ruminação'],
    ['07-carta-de-autocompaixao', 'Carta de autocompaixão'],
    ['08-minhas-qualidades', 'Minhas qualidades'],
    ['09-critico-interno-voz-gentil', 'Crítico interno × voz gentil'],
    ['10-lista-da-realidade', 'Lista da realidade'],
    ['11-meus-limites', 'Meus limites'],
    ['12-comunicacao-assertiva', 'Comunicação assertiva'],
    ['13-planejador-do-dia', 'Planejador do dia'],
    ['14-divisor-de-tarefas', 'Divisor de tarefas'],
    ['15-rotinas-de-manha-e-noite', 'Rotinas de manhã e noite'],
    ['16-diario-do-humor', 'Diário do humor'],
    ['17-meus-sinais-e-meu-plano', 'Meus sinais e meu plano'],
    ['18-ritmo-e-horarios-ancora', 'Ritmo e horários-âncora'],
  ],
};

const t = (name, label, hint) => ({ type: 'text', name, label, hint });
const ta = (name, label, hint) => ({ type: 'textarea', name, label, hint });
const sc = (name, label, left = '0', right = '10') => ({ type: 'scale', name, label, left, right });
const tb = (name, label, columns, rows = 3, chart = null) => ({ type: 'table', name, label, columns, rows, chart });
const col = (name, label, type = 'text') => ({ name, label, type });
const info = (text) => ({ type: 'info', text });
const SAFETY = info('Se em algum momento você sentir que pode se machucar, ligue para o CVV 188 (24 horas, gratuito) ou SAMU 192, ou procure o pronto-socorro mais próximo.');

const EMO = ['Alegria', 'Tristeza', 'Medo', 'Raiva', 'Nojo', 'Vergonha', 'Culpa', 'Ansiedade', 'Calma', 'Gratidão'];

export const FORMS = {
  'v1/01-meus-objetivos-na-terapia': [
    ta('motivo', 'O que me trouxe à terapia?'),
    tb('objetivos', 'Meus objetivos', [col('objetivo', 'Objetivo'), col('sinal', 'Como vou saber que cheguei lá?'), col('prioridade', 'Prioridade (1 a 5)', 'number')], 3),
    ta('recursos', 'Recursos e pessoas que podem me ajudar'),
  ],
  'v1/03-registro-de-pensamentos': [
    info('Preencha logo depois de perceber uma mudança no humor. Não existe resposta certa.'),
    tb('registros', 'Registros', [
      col('data', 'Data', 'date'), col('situacao', 'Situação'), col('pensamento', 'Pensamento automático'),
      col('emocao', 'Emoção'), col('intensidade', 'Intensidade (0–10)', 'number'),
      col('resposta', 'Resposta alternativa'), col('depois', 'Intensidade depois (0–10)', 'number'),
    ], 3, { x: 'data', y: ['intensidade', 'depois'], title: 'Intensidade antes × depois' }),
  ],
  'v1/05-questionando-um-pensamento': [
    t('pensamento', 'Pensamento que quero examinar'),
    sc('credito_antes', 'Quanto acredito nele agora (0–10)?'),
    ta('a_favor', 'Evidências a favor'),
    ta('contra', 'Evidências contra'),
    ta('amigo', 'O que eu diria a um amigo nessa situação?'),
    ta('alternativo', 'Pensamento mais equilibrado'),
    sc('credito_depois', 'Quanto acredito no pensamento original agora (0–10)?'),
  ],
  'v1/07-diario-de-emocoes': [
    tb('dias', 'Meu diário', [col('data', 'Dia', 'date'), col('emocao', 'Emoção principal'), col('intensidade', 'Intensidade (0–10)', 'number'), col('gatilho', 'O que aconteceu?'), col('acao', 'O que eu fiz?')], 7,
      { x: 'data', y: ['intensidade'], title: 'Intensidade das emoções na semana' }),
  ],
  'v1/08-monitoramento-de-atividades': [
    tb('atividades', 'Atividades do dia', [col('horario', 'Horário'), col('atividade', 'O que fiz'), col('prazer', 'Prazer (0–10)', 'number'), col('dominio', 'Domínio (0–10)', 'number')], 6,
      { x: 'horario', y: ['prazer', 'dominio'], title: 'Prazer e domínio ao longo do dia' }),
  ],
  'v1/09-agenda-de-atividades': [
    tb('plano', 'Atividades planejadas para a semana', [col('dia', 'Dia'), col('atividade', 'Atividade'), col('feito', 'Feito? (s/n)'), col('humor', 'Humor depois (0–10)', 'number')], 7,
      { x: 'dia', y: ['humor'], title: 'Humor depois das atividades' }),
  ],
  'v1/10-escada-de-exposicao': [
    t('medo', 'Situação que eu evito'),
    tb('degraus', 'Degraus (do mais fácil ao mais difícil)', [col('degrau', 'Situação'), col('ansiedade', 'Ansiedade esperada (0–10)', 'number'), col('real', 'Ansiedade real (0–10)', 'number'), col('data', 'Data', 'date')], 6,
      { x: 'degrau', y: ['ansiedade', 'real'], title: 'Ansiedade esperada × real' }),
  ],
  'v1/11-experimento-comportamental': [
    t('crenca', 'Crença a testar'), sc('credito_antes', 'Quanto acredito nela (0–10)?'),
    ta('experimento', 'Experimento: o que vou fazer, quando e onde'),
    ta('previsao', 'O que eu prevejo que vai acontecer'),
    ta('resultado', 'O que realmente aconteceu'),
    ta('aprendizado', 'O que aprendi'), sc('credito_depois', 'Quanto acredito na crença agora (0–10)?'),
  ],
  'v1/12-resolucao-de-problemas': [
    ta('problema', 'Qual é o problema (de forma concreta)?'),
    tb('opcoes', 'Possíveis soluções', [col('opcao', 'Opção'), col('pros', 'Vantagens'), col('contras', 'Desvantagens'), col('nota', 'Nota (0–10)', 'number')], 4),
    ta('plano', 'Solução escolhida e primeiros passos'),
    ta('avaliacao', 'Como foi? (preencher depois)'),
  ],
  'v1/13-pros-e-contras': [
    t('decisao', 'Decisão ou comportamento'),
    tb('lista', 'Prós e contras', [col('pro_curto', 'Prós (curto prazo)'), col('pro_longo', 'Prós (longo prazo)'), col('contra_curto', 'Contras (curto prazo)'), col('contra_longo', 'Contras (longo prazo)')], 4),
    ta('conclusao', 'O que concluo'),
  ],
  'v1/14-cartoes-de-enfrentamento': [
    tb('cartoes', 'Meus cartões', [col('situacao', 'Quando eu…'), col('lembrar', 'Vou me lembrar de…'), col('fazer', 'E vou fazer…')], 3),
  ],
  'v1/15-registro-de-conquistas': [
    tb('conquistas', 'Minhas conquistas', [col('data', 'Data', 'date'), col('conquista', 'O que consegui (pequeno ou grande)'), col('mostra', 'Isso mostra que eu…')], 7),
  ],
  'v1/16-plano-de-prevencao-de-recaida': [
    ta('aprendi', 'O que aprendi na terapia'),
    ta('sinais', 'Meus sinais de alerta'),
    ta('gatilhos', 'Situações de risco'),
    ta('estrategias', 'Estratégias que funcionam para mim'),
    ta('rede', 'Pessoas e contatos de apoio'),
    SAFETY,
  ],
  'v2/01-termometro-das-emocoes': [
    tb('registros', 'Medições do dia', [col('horario', 'Horário'), col('emocao', 'Emoção'), col('temperatura', 'Temperatura (0–10)', 'number'), col('corpo', 'Onde senti no corpo')], 5,
      { x: 'horario', y: ['temperatura'], title: 'Termômetro ao longo do dia' }),
    ta('acalmar', 'O que me ajudou a baixar a temperatura'),
  ],
  'v2/02-roda-das-emocoes': [
    { type: 'checks', name: 'emocoes', label: 'Emoções que senti esta semana', options: EMO },
    ta('nomear', 'Que nome mais preciso eu dou ao que senti?'),
  ],
  'v2/04-o-iceberg-das-emocoes': [
    ta('superficie', 'O que os outros veem (comportamento, raiva, irritação…)'),
    ta('fundo', 'O que está por baixo (medo, cansaço, tristeza, necessidades…)'),
    ta('necessidade', 'Do que eu preciso?'),
  ],
  'v2/05-pizza-da-responsabilidade': [
    t('situacao', 'Situação pela qual me culpo'), sc('culpa_antes', 'Quanto me sinto culpado(a) agora (0–10)?'),
    tb('fatias', 'Fatias da pizza (todos os fatores que contribuíram)', [col('fator', 'Pessoa ou fator'), col('percentual', '% da responsabilidade', 'number')], 5,
      { type: 'pie', label: 'fator', value: 'percentual', title: 'Pizza da responsabilidade' }),
    sc('culpa_depois', 'Quanto me sinto culpado(a) depois (0–10)?'),
  ],
  'v2/06-grafico-do-humor': [
    tb('dias', 'Meu humor dia a dia', [col('data', 'Dia', 'date'), col('humor', 'Humor (0–10)', 'number'), col('nota', 'O que influenciou')], 7,
      { x: 'data', y: ['humor'], title: 'Gráfico do humor' }),
  ],
  'v2/07-a-onda-da-ansiedade': [
    tb('onda', 'A onda (registre a ansiedade a cada poucos minutos)', [col('minuto', 'Minuto'), col('ansiedade', 'Ansiedade (0–10)', 'number')], 6,
      { x: 'minuto', y: ['ansiedade'], title: 'A onda da ansiedade' }),
    ta('aprendi', 'O que percebi sobre a onda'),
  ],
  'v2/08-circulos-de-controle': [
    t('situacao', 'Situação que me preocupa'),
    ta('controlo', 'O que eu controlo'), ta('influencio', 'O que eu influencio'), ta('nao_controlo', 'O que não depende de mim'),
    ta('foco', 'Onde vou colocar minha energia'),
  ],
  'v2/09-minha-bateria-de-energia': [
    sc('nivel', 'Como está minha bateria hoje (0–10)?'),
    ta('drena', 'O que drena minha energia'), ta('recarrega', 'O que recarrega minha energia'),
    ta('compromisso', 'Uma recarga que vou fazer esta semana'),
  ],
  'v2/10-a-balanca-da-decisao': [
    t('decisao', 'Decisão'), ta('lado_a', 'Razões para mudar'), ta('lado_b', 'Razões para continuar igual'),
    sc('peso', 'Para que lado a balança pende? (0 = continuar, 10 = mudar)', 'Continuar', 'Mudar'),
  ],
  'v2/12-roda-da-vida': [
    info('Dê uma nota de 0 a 10 para a sua satisfação em cada área da vida.'),
    sc('saude', 'Saúde'), sc('familia', 'Família'), sc('relacionamento', 'Relacionamento amoroso'), sc('amizades', 'Amizades'),
    sc('trabalho', 'Trabalho / estudos'), sc('financas', 'Finanças'), sc('lazer', 'Lazer'), sc('espiritualidade', 'Espiritualidade / propósito'),
    ta('prioridade', 'Qual área quero cuidar primeiro, e como?'),
    { type: 'radar', fields: ['saude', 'familia', 'relacionamento', 'amizades', 'trabalho', 'financas', 'lazer', 'espiritualidade'], title: 'Roda da vida' },
  ],
  'v2/13-alvo-dos-valores': [
    tb('valores', 'Meus valores', [col('area', 'Área'), col('valor', 'O que é importante para mim'), col('proximidade', 'Quão perto do alvo estou (0–10)', 'number')], 4,
      { x: 'area', y: ['proximidade'], title: 'Proximidade dos meus valores', type: 'bar' }),
    ta('acao', 'Uma ação na direção dos meus valores'),
  ],
  'v2/15-montanha-das-metas': [
    t('meta', 'Minha meta (o topo da montanha)'),
    tb('passos', 'Passos até o topo', [col('passo', 'Passo'), col('prazo', 'Prazo', 'date'), col('feito', 'Feito? (s/n)')], 5),
    ta('obstaculos', 'Possíveis obstáculos e como lidar'),
  ],
  'v2/16-o-semaforo-das-emocoes': [
    ta('vermelho', 'Vermelho — parar: o que sinto quando estou no limite?'),
    ta('amarelo', 'Amarelo — pensar: o que posso fazer para me acalmar?'),
    ta('verde', 'Verde — agir: qual a melhor resposta?'),
  ],
  'v2/17-kit-de-calma-dos-cinco-sentidos': [
    t('visao', 'Visão'), t('audicao', 'Audição'), t('olfato', 'Olfato'), t('paladar', 'Paladar'), t('tato', 'Tato'),
  ],
  'v3/01-plano-para-a-crise-de-ansiedade': [
    ta('sinais', 'Como percebo que a crise está começando'),
    ta('respiracao', 'Primeiro passo: respiração / aterramento que vou usar'),
    ta('frases', 'Frases que vou dizer a mim mesmo(a)'),
    ta('contatos', 'Quem posso chamar'),
    SAFETY,
  ],
  'v3/02-o-tempo-da-preocupacao': [
    t('horario', 'Meu horário da preocupação (15 a 20 min)'),
    tb('preocupacoes', 'Preocupações adiadas', [col('preocupacao', 'Preocupação'), col('resolvivel', 'Posso resolver? (s/n)'), col('acao', 'Próximo passo ou aceitação')], 5),
  ],
  'v3/04-cardapio-de-atividades': [
    tb('cardapio', 'Meu cardápio', [col('tipo', 'Tipo (entrada, prato principal, sobremesa)'), col('atividade', 'Atividade'), col('tempo', 'Tempo')], 6),
  ],
  'v3/06-saindo-da-ruminacao': [
    t('tema', 'Sobre o que estou ruminando?'), sc('tempo', 'Quanto tempo isso tem ocupado (0–10)?'),
    ta('util', 'Isso está me levando a alguma solução?'),
    ta('saida', 'Atividade para sair da ruminação agora'),
  ],
  'v3/07-carta-de-autocompaixao': [
    info('Escreva para você como escreveria para alguém que ama, passando pela mesma situação.'),
    ta('carta', 'Minha carta'),
  ],
  'v3/08-minhas-qualidades': [
    tb('qualidades', 'Minhas qualidades', [col('qualidade', 'Qualidade'), col('exemplo', 'Um exemplo em que eu mostrei isso')], 6),
  ],
  'v3/09-critico-interno-voz-gentil': [
    tb('dialogo', 'Diálogo', [col('critico', 'O crítico interno diz…'), col('gentil', 'A voz gentil responde…')], 4),
  ],
  'v3/10-lista-da-realidade': [
    t('medo', 'O que estou temendo'),
    ta('fatos', 'O que eu sei com certeza (fatos)'),
    ta('suposicoes', 'O que estou supondo'),
    sc('probabilidade', 'Probabilidade realista de acontecer (0–10)'),
  ],
  'v3/11-meus-limites': [
    tb('limites', 'Meus limites', [col('area', 'Área / pessoa'), col('limite', 'O limite'), col('frase', 'Como vou comunicar')], 4),
  ],
  'v3/12-comunicacao-assertiva': [
    t('situacao', 'Situação'), ta('fato', 'Quando… (fato, sem julgamento)'), ta('sinto', 'Eu me sinto…'),
    ta('preciso', 'Porque preciso de…'), ta('peco', 'Gostaria que…'),
  ],
  'v3/13-planejador-do-dia': [
    t('prioridade', 'A prioridade do dia'),
    tb('blocos', 'Blocos do dia', [col('horario', 'Horário'), col('tarefa', 'Tarefa'), col('feito', 'Feito? (s/n)')], 6),
    ta('cuidado', 'Um cuidado comigo hoje'),
  ],
  'v3/14-divisor-de-tarefas': [
    t('tarefa', 'Tarefa grande'),
    tb('partes', 'Partes pequenas', [col('parte', 'Parte'), col('tempo', 'Tempo estimado'), col('feito', 'Feito? (s/n)')], 6),
  ],
  'v3/15-rotinas-de-manha-e-noite': [
    ta('manha', 'Minha rotina da manhã'), ta('noite', 'Minha rotina da noite'),
  ],
  'v3/16-diario-do-humor': [
    tb('dias', 'Diário do humor', [col('data', 'Dia', 'date'), col('humor', 'Humor (0–10)', 'number'), col('sono', 'Horas de sono', 'number'), col('energia', 'Energia (0–10)', 'number'), col('nota', 'Observação')], 7,
      { x: 'data', y: ['humor', 'energia'], title: 'Humor e energia' }),
  ],
  'v3/17-meus-sinais-e-meu-plano': [
    ta('verde', 'Quando estou bem, eu…'),
    ta('amarelo', 'Sinais de atenção'),
    ta('vermelho', 'Sinais de alerta'),
    ta('plano', 'O que eu faço e a quem aviso'),
    SAFETY,
  ],
  'v3/18-ritmo-e-horarios-ancora': [
    tb('ancoras', 'Horários-âncora da semana', [col('dia', 'Dia'), col('acordar', 'Acordei'), col('primeiro_contato', '1º contato com pessoas'), col('refeicao', 'Refeição principal'), col('dormir', 'Fui dormir')], 7),
  ],
};

export const EXERCISES = [];
for (const [book, items] of Object.entries(LIST)) {
  for (const [slug, title] of items) {
    const key = `${book}/${slug}`;
    EXERCISES.push({ key, book, slug, title, num: slug.slice(0, 2), bookTitle: BOOKS[book].title, pdf: `${BOOKS[book].dir}/${slug}.pdf`, form: FORMS[key] || null });
  }
}
export const byKey = (k) => EXERCISES.find((e) => e.key === k) || null;
