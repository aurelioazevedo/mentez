// Estilos do sistema (Identidade da clínica → Estilo): cada um muda cores, fontes, cantos e sombras, com versão clara
// e escura. A paleta própria da clínica (até 4 cores), se escolhida, vai por cima da do estilo.
// “classico” é o visual original (o da Dra. Lorrainy), definido no próprio app.css: não precisa de variáveis aqui.
const F = (q) => `https://fonts.googleapis.com/css2?${q}&display=swap`;
const SANS = (name) => `'${name}', system-ui, -apple-system, 'Segoe UI', sans-serif`;

export const STYLES = {
  mentez: {
    label: 'Mentez', desc: 'Azul-marinho e turquesa, moderno e limpo.', fonts: F('family=Plus+Jakarta+Sans:wght@400;500;600;700'),
    serif: SANS('Plus Jakarta Sans'), sans: SANS('Plus Jakarta Sans'), r: 18,
    light: { terracota: '#04857E', 'terracota-d': '#036B65', 'terracota-l': '#07C6BC', creme: '#E6F6EF', 'creme-deep': '#BDE5D2', musgo: '#5B47C9', marrom: '#1E3663', 'marrom-deep': '#071936', bg: '#F5F7FC', bg2: '#E8EDF5', ink: '#0D2246', muted: '#4F5E74', line: '#D9E0EC', card: '#fff', surface: '#fff', 'surface-2': '#F5F7FC', 'strong-bg': '#071936', 'strong-ink': '#F5F7FC', 'strong-accent': '#07C6BC' },
    dark: { terracota: '#07C6BC', 'terracota-d': '#3BD6CD', 'terracota-l': '#07C6BC', creme: '#132C57', 'creme-deep': '#1E3663', marrom: '#C9D2E3', 'marrom-deep': '#F5F7FC', bg: '#071936', bg2: '#0D2246', ink: '#F5F7FC', muted: '#A9B5CA', line: '#1E3663', card: '#0D2246', surface: '#0D2246', 'surface-2': '#132C57', 'strong-bg': '#132C57', 'strong-ink': '#F5F7FC' },
    css: 'h1,h2,h3{font-weight:700;letter-spacing:-.01em}',
  },
  classico: {
    label: 'Clássico acolhedor', desc: 'Terracota e creme, títulos com serifa. Caloroso e elegante.', fonts: F('family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Instrument+Sans:wght@400;500;600'),
    serif: "'Fraunces', Georgia, serif", sans: SANS('Instrument Sans'), r: 18, light: null, dark: null, css: '',
    swatch: { bg: '#f6f0e8', accent: '#9c4422', ink: '#2e2219', soft: '#e5d8c6' },
  },
  sereno: {
    label: 'Sereno', desc: 'Verde-sálvia e areia, cantos bem arredondados. Calmo e natural.', fonts: F('family=Nunito:wght@400;500;600;700'),
    serif: SANS('Nunito'), sans: SANS('Nunito'), r: 24,
    light: { terracota: '#5E8C6A', 'terracota-d': '#4A7356', 'terracota-l': '#8DB59A', creme: '#E7F0E6', 'creme-deep': '#C9DDC8', musgo: '#C08B5C', marrom: '#4A5A4E', 'marrom-deep': '#2F3B32', bg: '#F6F4EE', bg2: '#ECE8DE', ink: '#2B332D', muted: '#6B746C', line: '#E2DDD1', card: '#FFFEFB', surface: '#FFFEFB', 'surface-2': '#F7F5EF', 'strong-bg': '#2F3B32', 'strong-ink': '#F1EFE7', 'strong-accent': '#B8D4BF' },
    dark: { terracota: '#8DB59A', 'terracota-d': '#A9CBB3', 'terracota-l': '#8DB59A', creme: '#26332A', 'creme-deep': '#33443A', marrom: '#C8D3C9', 'marrom-deep': '#EEF2EC', bg: '#151A16', bg2: '#1C231E', ink: '#EEF2EC', muted: '#A7B2A9', line: '#2C372F', card: '#1C231E', surface: '#1C231E', 'surface-2': '#232C25', 'strong-bg': '#26332A', 'strong-ink': '#EEF2EC' },
    css: 'h1,h2,h3{font-weight:700}.card,.kpi{border-radius:24px}.btn,.chip,input,select,textarea{border-radius:14px}',
  },
  minimal: {
    label: 'Minimalista', desc: 'Branco, cinza e grafite, linhas finas e sem sombras. Direto ao ponto.', fonts: F('family=Inter:wght@400;500;600;700'),
    serif: SANS('Inter'), sans: SANS('Inter'), r: 10,
    light: { terracota: '#1F2937', 'terracota-d': '#111827', 'terracota-l': '#4B5563', creme: '#F3F4F6', 'creme-deep': '#E5E7EB', musgo: '#2563EB', marrom: '#374151', 'marrom-deep': '#111827', bg: '#FAFAFA', bg2: '#F3F4F6', ink: '#111827', muted: '#6B7280', line: '#E5E7EB', card: '#fff', surface: '#fff', 'surface-2': '#FAFAFA', 'strong-bg': '#111827', 'strong-ink': '#F9FAFB', 'strong-accent': '#93C5FD' },
    dark: { terracota: '#E5E7EB', 'terracota-d': '#F9FAFB', 'terracota-l': '#D1D5DB', creme: '#1F2937', 'creme-deep': '#374151', marrom: '#D1D5DB', 'marrom-deep': '#F9FAFB', bg: '#0B0F14', bg2: '#111827', ink: '#F3F4F6', muted: '#9CA3AF', line: '#1F2937', card: '#111827', surface: '#111827', 'surface-2': '#1F2937', 'strong-bg': '#1F2937', 'strong-ink': '#F9FAFB' },
    css: 'h1,h2,h3{font-weight:600;letter-spacing:-.02em}.card,.kpi{border-radius:10px;box-shadow:none !important}.btn,.chip,input,select,textarea{border-radius:8px}.side nav a{border-radius:8px}:root{--shadow:none}',
  },
  lavanda: {
    label: 'Lavanda', desc: 'Lilás e violeta suaves. Delicado e acolhedor.', fonts: F('family=Manrope:wght@400;500;600;700'),
    serif: SANS('Manrope'), sans: SANS('Manrope'), r: 18,
    light: { terracota: '#6D5BD0', 'terracota-d': '#5847B5', 'terracota-l': '#9B8CE6', creme: '#EFEBFB', 'creme-deep': '#D9D1F5', musgo: '#D7709B', marrom: '#463D73', 'marrom-deep': '#2A2350', bg: '#F8F6FD', bg2: '#EFEBF8', ink: '#272144', muted: '#6E6890', line: '#E4DFF2', card: '#fff', surface: '#fff', 'surface-2': '#FAF8FE', 'strong-bg': '#2A2350', 'strong-ink': '#F3F0FD', 'strong-accent': '#C4B8F5' },
    dark: { terracota: '#A99BF0', 'terracota-d': '#C3B9F6', 'terracota-l': '#A99BF0', creme: '#2A2448', 'creme-deep': '#3A3263', marrom: '#D2CCEE', 'marrom-deep': '#F3F0FD', bg: '#15122A', bg2: '#1C1835', ink: '#F3F0FD', muted: '#ACA6CC', line: '#2E2850', card: '#1C1835', surface: '#1C1835', 'surface-2': '#241F42', 'strong-bg': '#2A2448', 'strong-ink': '#F3F0FD' },
    css: 'h1,h2,h3{font-weight:700;letter-spacing:-.01em}',
  },
  oceano: {
    label: 'Oceano', desc: 'Azul e branco, claro e profissional.', fonts: F('family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700'),
    serif: SANS('DM Sans'), sans: SANS('DM Sans'), r: 14,
    light: { terracota: '#1F6FB2', 'terracota-d': '#185A92', 'terracota-l': '#5A9BD3', creme: '#E6F0FA', 'creme-deep': '#C8DDF2', musgo: '#0FA3A3', marrom: '#27486B', 'marrom-deep': '#0F2A47', bg: '#F4F8FC', bg2: '#E7EFF7', ink: '#132B45', muted: '#5A6F86', line: '#DCE6F0', card: '#fff', surface: '#fff', 'surface-2': '#F5F9FD', 'strong-bg': '#0F2A47', 'strong-ink': '#EEF5FC', 'strong-accent': '#8EC5F0' },
    dark: { terracota: '#5AA6E6', 'terracota-d': '#80BCEE', 'terracota-l': '#5AA6E6', creme: '#14304D', 'creme-deep': '#1D4268', marrom: '#C6D7EA', 'marrom-deep': '#EEF5FC', bg: '#0A1828', bg2: '#0F2135', ink: '#EEF5FC', muted: '#9DB2C8', line: '#1B3350', card: '#0F2135', surface: '#0F2135', 'surface-2': '#152B45', 'strong-bg': '#14304D', 'strong-ink': '#EEF5FC' },
    css: 'h1,h2,h3{font-weight:700;letter-spacing:-.01em}.card,.kpi{border-radius:14px}.btn,.chip,input,select,textarea{border-radius:10px}',
  },
  editorial: {
    label: 'Editorial', desc: 'Grafite e dourado, títulos grandes com serifa. Sofisticado.', fonts: F('family=DM+Serif+Display&family=Inter:wght@400;500;600'),
    serif: "'DM Serif Display', Georgia, serif", sans: SANS('Inter'), r: 8,
    light: { terracota: '#9A7B45', 'terracota-d': '#7E6436', 'terracota-l': '#C2A26A', creme: '#F3EEE4', 'creme-deep': '#E2D7C2', musgo: '#3F5A55', marrom: '#3A3A3A', 'marrom-deep': '#1C1C1C', bg: '#F8F7F4', bg2: '#EFEDE8', ink: '#1C1C1C', muted: '#6A6762', line: '#E3E0DA', card: '#fff', surface: '#fff', 'surface-2': '#FAF9F6', 'strong-bg': '#1C1C1C', 'strong-ink': '#F3EEE4', 'strong-accent': '#D9BF8C' },
    dark: { terracota: '#D2B57E', 'terracota-d': '#E0C796', 'terracota-l': '#D2B57E', creme: '#2C2820', 'creme-deep': '#3B352A', marrom: '#D8D4CC', 'marrom-deep': '#F5F2EC', bg: '#121212', bg2: '#1A1A1A', ink: '#F2EFE9', muted: '#A9A59E', line: '#2A2A2A', card: '#1A1A1A', surface: '#1A1A1A', 'surface-2': '#222', 'strong-bg': '#2C2820', 'strong-ink': '#F5F2EC' },
    css: 'h1{font-weight:400;letter-spacing:-.01em}h2,h3{font-weight:400}.card,.kpi{border-radius:8px}.btn,.chip,input,select,textarea{border-radius:6px}',
  },
  aurora: {
    label: 'Aurora', desc: 'Vidro translúcido sobre degradê nas cores Mentez (turquesa, violeta e azul); títulos com serifa. Moderno e leve.', fonts: F('family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Plus+Jakarta+Sans:wght@400;500;600;700'),
    serif: "'Fraunces', Georgia, serif", sans: SANS('Plus Jakarta Sans'), r: 24,
    light: { terracota: '#04857E', 'terracota-d': '#036B65', 'terracota-l': '#07C6BC', creme: 'rgba(7,198,188,.10)', 'creme-deep': 'rgba(7,198,188,.20)', musgo: '#8065E8', marrom: '#1E3663', 'marrom-deep': '#071936', bg: '#F2F6FB', bg2: 'rgba(255,255,255,.45)', ink: '#0D2246', muted: '#4F5E74', line: 'rgba(30,54,99,.12)', card: 'rgba(255,255,255,.64)', surface: 'rgba(255,255,255,.74)', 'surface-2': 'rgba(255,255,255,.45)', 'strong-bg': '#071936', 'strong-ink': '#F5F7FC', 'strong-accent': '#07C6BC', shadow: '0 1px 1px rgba(7,25,54,.04), 0 14px 36px -16px rgba(7,25,54,.25)' },
    dark: { terracota: '#07C6BC', 'terracota-d': '#3BD6CD', 'terracota-l': '#07C6BC', creme: 'rgba(7,198,188,.12)', 'creme-deep': 'rgba(7,198,188,.22)', musgo: '#A08CF2', marrom: '#C9D2E3', 'marrom-deep': '#F5F7FC', bg: '#071936', bg2: 'rgba(255,255,255,.05)', ink: '#F5F7FC', muted: '#A9B5CA', line: 'rgba(255,255,255,.10)', card: 'rgba(19,44,87,.55)', surface: 'rgba(19,44,87,.65)', 'surface-2': 'rgba(255,255,255,.06)', 'strong-bg': '#132C57', 'strong-ink': '#F5F7FC', shadow: '0 1px 1px rgba(0,0,0,.3), 0 18px 40px -18px rgba(0,0,0,.6)' },
    css: [
      'body{background:radial-gradient(1100px 700px at -5% -10%,#D3F3EF 0%,transparent 60%),radial-gradient(1000px 650px at 105% 0%,#DCE5FA 0%,transparent 58%),radial-gradient(900px 700px at 50% 110%,#E7E1FB 0%,transparent 62%),#F2F6FB;background-attachment:fixed}',
      ':root[data-theme="dark"] body{background:radial-gradient(1100px 700px at -5% -10%,#0E3B4A 0%,transparent 60%),radial-gradient(1000px 650px at 105% 0%,#1A2F66 0%,transparent 58%),radial-gradient(900px 700px at 50% 110%,#2A2160 0%,transparent 62%),#071936;background-attachment:fixed}',
      '@media (prefers-color-scheme: dark){:root[data-theme="auto"] body{background:radial-gradient(1100px 700px at -5% -10%,#0E3B4A 0%,transparent 60%),radial-gradient(1000px 650px at 105% 0%,#1A2F66 0%,transparent 58%),radial-gradient(900px 700px at 50% 110%,#2A2160 0%,transparent 62%),#071936;background-attachment:fixed}}',
      '.card,.kpi,.side-card,.tsearch,.st-opt,.cfg-item{-webkit-backdrop-filter:blur(18px) saturate(150%);backdrop-filter:blur(18px) saturate(150%);border-color:rgba(255,255,255,.7) !important}',
      ':root[data-theme="dark"] .card,:root[data-theme="dark"] .kpi,:root[data-theme="dark"] .side-card,:root[data-theme="dark"] .tsearch{border-color:rgba(255,255,255,.10) !important}',
      '.card,.kpi{border-radius:24px}.side-card{border-radius:26px}',
      'h1,h2{font-family:var(--serif);font-weight:500;letter-spacing:-.01em}h3{font-weight:700}',
      '.btn:not(.ghost):not(.danger){background:linear-gradient(135deg,var(--terracota-l),var(--terracota) 55%,var(--musgo));border-color:transparent;box-shadow:0 8px 20px -10px var(--terracota)}',
      '.btn.ghost{background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}:root[data-theme="dark"] .btn.ghost{background:rgba(255,255,255,.06)}',
      '.side nav a{background:rgba(255,255,255,.45);border-color:rgba(255,255,255,.6)}:root[data-theme="dark"] .side nav a{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}',
      '.side nav a.on{background:linear-gradient(135deg,var(--terracota-l),var(--terracota) 60%,var(--musgo));border-color:transparent;box-shadow:0 10px 24px -12px var(--terracota)}',
      'input,select,textarea{border-radius:14px}.chip,.badge{border-radius:999px}',
      ':root[data-theme="dark"] .side nav a.on{background:linear-gradient(135deg,#3BD6CD,#07C6BC 55%,#A08CF2);border-color:transparent;color:#071936}',
      ':root[data-theme="dark"] .btn:not(.ghost):not(.danger){color:#071936}',
      '@media (prefers-color-scheme: dark){:root[data-theme="auto"] .side nav a{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}:root[data-theme="auto"] .side nav a.on{background:linear-gradient(135deg,#3BD6CD,#07C6BC 55%,#A08CF2);border-color:transparent;color:#071936}:root[data-theme="auto"] .btn:not(.ghost):not(.danger){color:#071936}:root[data-theme="auto"] .btn.ghost{background:rgba(255,255,255,.06)}:root[data-theme="auto"] .card,:root[data-theme="auto"] .kpi,:root[data-theme="auto"] .side-card,:root[data-theme="auto"] .tsearch{border-color:rgba(255,255,255,.10) !important}}',
      // celular e tablet: o desfoque ao vivo (backdrop-filter) em todos os cartões pesa muito no iPhone e deixa a troca de tela lenta;
      // no lugar, cartões quase opacos (mesmo visual, sem custo de pintura)
      '@media (max-width: 900px), (hover: none) {',
      '.card,.kpi,.side-card,.tsearch,.st-opt,.cfg-item,.btn.ghost{-webkit-backdrop-filter:none !important;backdrop-filter:none !important}',
      'body{background-attachment:scroll !important}',
      // o que flutua sobre o conteúdo (menu de baixo, aviso de instalar) fica sólido para o texto de trás não aparecer
      '.side-card,.inst-banner{background:#F7FAFD !important}:root[data-theme="dark"] .side-card,:root[data-theme="dark"] .inst-banner{background:#0F2549 !important}',
      '.card,.kpi,.side-card,.cfg-item,.st-opt{background:rgba(255,255,255,.9)}.tsearch{background:rgba(255,255,255,.94)}.btn.ghost{background:rgba(255,255,255,.85)}',
      ':root[data-theme="dark"] .card,:root[data-theme="dark"] .kpi,:root[data-theme="dark"] .side-card,:root[data-theme="dark"] .cfg-item,:root[data-theme="dark"] .st-opt,:root[data-theme="dark"] .tsearch{background:rgba(16,38,77,.94)}:root[data-theme="dark"] .btn.ghost{background:rgba(255,255,255,.08)}',
      '}',
      '@media (max-width: 900px) and (prefers-color-scheme: dark), (hover: none) and (prefers-color-scheme: dark) {:root[data-theme="auto"] .side-card,:root[data-theme="auto"] .inst-banner{background:#0F2549 !important}:root[data-theme="auto"] .card,:root[data-theme="auto"] .kpi,:root[data-theme="auto"] .side-card,:root[data-theme="auto"] .cfg-item,:root[data-theme="auto"] .st-opt,:root[data-theme="auto"] .tsearch{background:rgba(16,38,77,.94)}:root[data-theme="auto"] .btn.ghost{background:rgba(255,255,255,.08)}}',
    ].join(''),
    swatch: { bg: '#E9F3F6', accent: '#04857E', ink: '#0D2246', soft: '#D3F3EF', dark: '#071936' },
  },
};
export const keyOf = (k, legacy) => (STYLES[k] ? k : legacy ? 'classico' : 'mentez');
const vars = (o) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';');

export function css(key) {
  const s = STYLES[key]; if (!s) return '';
  const out = [];
  if (s.light) out.push(`:root,.letter{${vars(s.light)};--serif:${s.serif};--sans:${s.sans};--r:${s.r}px}`);
  else out.push(`:root,.letter{--serif:${s.serif};--sans:${s.sans}}`);
  if (s.dark) {
    out.push(`:root[data-theme="dark"]{${vars(s.dark)}}`);
    out.push(`@media (prefers-color-scheme: dark){:root[data-theme="auto"]{${vars(s.dark)}}}`);
  }
  if (s.css) out.push(s.css);
  return out.join('\n');
}
// Cores principais (prévia na tela de escolha, cartão digital e link na bio)
export function swatch(key) {
  const s = STYLES[key] || STYLES.mentez;
  if (s.swatch) return s.swatch;
  return { bg: s.light.bg, accent: s.light.terracota, ink: s.light.ink, soft: s.light.creme, dark: s.light['strong-bg'] };
}
// Todas as fontes numa folha só (tela de escolha do estilo)
export const allFonts = () => F('family=Plus+Jakarta+Sans:wght@500;700&family=Fraunces:opsz,wght@9..144,500&family=Instrument+Sans:wght@500&family=Nunito:wght@500;700&family=Inter:wght@500;600&family=Manrope:wght@500;700&family=DM+Sans:wght@500;700&family=DM+Serif+Display');
