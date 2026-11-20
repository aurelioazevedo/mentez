// Sugestões de CID-10 (capítulo V, F00–F99, e alguns Z) e CID-11 (capítulo 6) para o campo de hipótese diagnóstica.
// É só uma lista de apoio para a busca: qualquer código válido pode ser digitado, mesmo fora dela.
export const CID10 = [
  ['F00', 'Demência na doença de Alzheimer'], ['F01', 'Demência vascular'], ['F03', 'Demência não especificada'],
  ['F04', 'Síndrome amnésica orgânica não induzida pelo álcool ou por outras substâncias psicoativas'], ['F05', 'Delirium não induzido pelo álcool ou por outras substâncias psicoativas'],
  ['F06', 'Outros transtornos mentais devidos a lesão e disfunção cerebral e a doença física'], ['F07', 'Transtornos de personalidade e do comportamento devidos a doença, a lesão e a disfunção cerebral'],
  ['F10', 'Transtornos mentais e comportamentais devidos ao uso de álcool'], ['F11', 'Transtornos mentais e comportamentais devidos ao uso de opiáceos'],
  ['F12', 'Transtornos mentais e comportamentais devidos ao uso de canabinóides'], ['F13', 'Transtornos mentais e comportamentais devidos ao uso de sedativos e hipnóticos'],
  ['F14', 'Transtornos mentais e comportamentais devidos ao uso da cocaína'], ['F15', 'Transtornos mentais e comportamentais devidos ao uso de outros estimulantes, inclusive a cafeína'],
  ['F16', 'Transtornos mentais e comportamentais devidos ao uso de alucinógenos'], ['F17', 'Transtornos mentais e comportamentais devidos ao uso de fumo'],
  ['F18', 'Transtornos mentais e comportamentais devidos ao uso de solventes voláteis'], ['F19', 'Transtornos mentais e comportamentais devidos ao uso de múltiplas drogas e ao uso de outras substâncias psicoativas'],
  ['F20', 'Esquizofrenia'], ['F21', 'Transtorno esquizotípico'], ['F22', 'Transtornos delirantes persistentes'], ['F23', 'Transtornos psicóticos agudos e transitórios'],
  ['F24', 'Transtorno delirante induzido'], ['F25', 'Transtornos esquizoafetivos'], ['F28', 'Outros transtornos psicóticos não-orgânicos'], ['F29', 'Psicose não-orgânica não especificada'],
  ['F30', 'Episódio maníaco'], ['F31', 'Transtorno afetivo bipolar'], ['F31.0', 'Transtorno afetivo bipolar, episódio atual hipomaníaco'],
  ['F31.3', 'Transtorno afetivo bipolar, episódio atual depressivo leve ou moderado'], ['F31.4', 'Transtorno afetivo bipolar, episódio atual depressivo grave sem sintomas psicóticos'],
  ['F31.7', 'Transtorno afetivo bipolar, atualmente em remissão'],
  ['F32', 'Episódios depressivos'], ['F32.0', 'Episódio depressivo leve'], ['F32.1', 'Episódio depressivo moderado'], ['F32.2', 'Episódio depressivo grave sem sintomas psicóticos'],
  ['F32.3', 'Episódio depressivo grave com sintomas psicóticos'], ['F32.9', 'Episódio depressivo não especificado'],
  ['F33', 'Transtorno depressivo recorrente'], ['F33.0', 'Transtorno depressivo recorrente, episódio atual leve'], ['F33.1', 'Transtorno depressivo recorrente, episódio atual moderado'],
  ['F33.2', 'Transtorno depressivo recorrente, episódio atual grave sem sintomas psicóticos'], ['F33.4', 'Transtorno depressivo recorrente, atualmente em remissão'],
  ['F34', 'Transtornos de humor (afetivos) persistentes'], ['F34.0', 'Ciclotimia'], ['F34.1', 'Distimia'], ['F38', 'Outros transtornos do humor (afetivos)'], ['F39', 'Transtorno do humor (afetivo) não especificado'],
  ['F40', 'Transtornos fóbico-ansiosos'], ['F40.0', 'Agorafobia'], ['F40.1', 'Fobias sociais'], ['F40.2', 'Fobias específicas (isoladas)'],
  ['F41', 'Outros transtornos ansiosos'], ['F41.0', 'Transtorno de pânico (ansiedade paroxística episódica)'], ['F41.1', 'Ansiedade generalizada'],
  ['F41.2', 'Transtorno misto ansioso e depressivo'], ['F41.9', 'Transtorno ansioso não especificado'],
  ['F42', 'Transtorno obsessivo-compulsivo'], ['F42.0', 'Com predominância de idéias ou de ruminações obsessivas'], ['F42.1', 'Com predominância de comportamentos compulsivos'], ['F42.2', 'Forma mista, com idéias obsessivas e comportamentos compulsivos'],
  ['F43', 'Reações ao "stress" grave e transtornos de adaptação'], ['F43.0', 'Reação aguda ao "stress"'], ['F43.1', 'Estado de "stress" pós-traumático'], ['F43.2', 'Transtornos de adaptação'],
  ['F44', 'Transtornos dissociativos (de conversão)'], ['F45', 'Transtornos somatoformes'], ['F45.2', 'Transtorno hipocondríaco'], ['F48', 'Outros transtornos neuróticos'], ['F48.0', 'Neurastenia'],
  ['F50', 'Transtornos da alimentação'], ['F50.0', 'Anorexia nervosa'], ['F50.2', 'Bulimia nervosa'], ['F50.9', 'Transtorno de alimentação não especificado'],
  ['F51', 'Transtornos não-orgânicos do sono devidos a fatores emocionais'], ['F51.0', 'Insônia não-orgânica'], ['F52', 'Disfunção sexual, não causada por transtorno ou doença orgânica'],
  ['F53', 'Transtornos mentais e comportamentais associados ao puerpério, não classificados em outra parte'], ['F54', 'Fatores psicológicos ou comportamentais associados a doença ou a transtornos classificados em outra parte'],
  ['F55', 'Abuso de substâncias que não produzem dependência'],
  ['F60', 'Transtornos específicos da personalidade'], ['F60.3', 'Transtorno de personalidade com instabilidade emocional'], ['F60.31', 'Transtorno de personalidade com instabilidade emocional, tipo borderline'],
  ['F60.5', 'Personalidade anancástica'], ['F60.6', 'Personalidade ansiosa (esquiva)'], ['F60.7', 'Personalidade dependente'],
  ['F61', 'Transtornos mistos da personalidade e outros transtornos da personalidade'], ['F62', 'Modificações duradouras da personalidade não atribuíveis a lesão ou doença cerebral'],
  ['F63', 'Transtornos dos hábitos e dos impulsos'], ['F63.0', 'Jogo patológico'], ['F63.3', 'Tricotilomania'], ['F64', 'Transtornos da identidade sexual'],
  ['F68', 'Outros transtornos da personalidade e do comportamento do adulto'], ['F69', 'Transtorno da personalidade e do comportamento do adulto, não especificado'],
  ['F70', 'Retardo mental leve'], ['F71', 'Retardo mental moderado'], ['F79', 'Retardo mental não especificado'],
  ['F80', 'Transtornos específicos do desenvolvimento da fala e da linguagem'], ['F81', 'Transtornos específicos do desenvolvimento das habilidades escolares'],
  ['F82', 'Transtorno específico do desenvolvimento motor'], ['F84', 'Transtornos globais do desenvolvimento'], ['F84.0', 'Autismo infantil'], ['F84.5', 'Síndrome de Asperger'],
  ['F88', 'Outros transtornos do desenvolvimento psicológico'], ['F89', 'Transtorno do desenvolvimento psicológico não especificado'],
  ['F90', 'Transtornos hipercinéticos'], ['F90.0', 'Distúrbios da atividade e da atenção'], ['F91', 'Distúrbios de conduta'], ['F91.3', 'Distúrbio desafiador e de oposição'],
  ['F92', 'Transtornos mistos de conduta e das emoções'], ['F93', 'Transtornos emocionais com início especificamente na infância'], ['F93.0', 'Transtorno ligado à angústia de separação'],
  ['F94', 'Transtornos do funcionamento social com início especificamente durante a infância ou a adolescência'], ['F95', 'Tiques'],
  ['F98', 'Outros transtornos comportamentais e emocionais com início habitualmente durante a infância ou a adolescência'], ['F98.0', 'Enurese de origem não-orgânica'],
  ['F99', 'Transtorno mental não especificado em outra parte'],
  ['Z63', 'Outros problemas relacionados com o grupo primário de apoio, inclusive com a situação familiar'], ['Z73.0', 'Esgotamento ("burnout")'],
];

export const CID11 = [
  ['6A00', 'Transtornos do desenvolvimento intelectual'], ['6A01', 'Transtornos do desenvolvimento da fala ou da linguagem'], ['6A02', 'Transtorno do espectro do autismo'],
  ['6A03', 'Transtorno do desenvolvimento da aprendizagem'], ['6A04', 'Transtorno do desenvolvimento da coordenação motora'], ['6A05', 'Transtorno de déficit de atenção e hiperatividade'],
  ['6A06', 'Transtorno de movimentos estereotipados'],
  ['6A20', 'Esquizofrenia'], ['6A21', 'Transtorno esquizoafetivo'], ['6A22', 'Transtorno esquizotípico'], ['6A23', 'Transtorno psicótico agudo e transitório'], ['6A24', 'Transtorno delirante'],
  ['6A60', 'Transtorno bipolar tipo I'], ['6A61', 'Transtorno bipolar tipo II'], ['6A62', 'Transtorno ciclotímico'],
  ['6A70', 'Transtorno depressivo de episódio único'], ['6A71', 'Transtorno depressivo recorrente'], ['6A72', 'Transtorno distímico'], ['6A73', 'Transtorno misto de depressão e ansiedade'],
  ['6B00', 'Transtorno de ansiedade generalizada'], ['6B01', 'Transtorno de pânico'], ['6B02', 'Agorafobia'], ['6B03', 'Fobia específica'], ['6B04', 'Transtorno de ansiedade social'],
  ['6B05', 'Transtorno de ansiedade de separação'], ['6B06', 'Mutismo seletivo'],
  ['6B20', 'Transtorno obsessivo-compulsivo'], ['6B21', 'Transtorno dismórfico corporal'], ['6B23', 'Hipocondria'], ['6B24', 'Transtorno de acumulação'], ['6B25', 'Transtornos de comportamento repetitivo focado no corpo'],
  ['6B40', 'Transtorno de estresse pós-traumático'], ['6B41', 'Transtorno de estresse pós-traumático complexo'], ['6B42', 'Transtorno de luto prolongado'], ['6B43', 'Transtorno de adaptação'],
  ['6B44', 'Transtorno de apego reativo'], ['6B45', 'Transtorno de interação social desinibida'],
  ['6B60', 'Transtorno dissociativo de sintomas neurológicos'], ['6B64', 'Transtorno dissociativo de identidade'],
  ['6B80', 'Anorexia nervosa'], ['6B81', 'Bulimia nervosa'], ['6B82', 'Transtorno de compulsão alimentar'], ['6B83', 'Transtorno alimentar restritivo/evitativo'],
  ['6C00', 'Enurese'], ['6C01', 'Encoprese'], ['6C20', 'Transtorno de sofrimento corporal'],
  ['6C40', 'Transtornos devidos ao uso de álcool'], ['6C41', 'Transtornos devidos ao uso de cannabis'], ['6C45', 'Transtornos devidos ao uso de cocaína'], ['6C4A', 'Transtornos devidos ao uso de nicotina'],
  ['6C50', 'Transtorno de jogo (apostas)'], ['6C51', 'Transtorno de jogo (games)'],
  ['6C70', 'Piromania'], ['6C71', 'Cleptomania'], ['6C72', 'Transtorno de comportamento sexual compulsivo'], ['6C73', 'Transtorno explosivo intermitente'],
  ['6C90', 'Transtorno desafiador de oposição'], ['6C91', 'Transtorno de conduta dissocial'],
  ['6D10', 'Transtorno de personalidade'], ['6D11', 'Traços ou padrões de personalidade proeminentes'], ['6D11.5', 'Padrão borderline'],
  ['6D70', 'Delirium'], ['6D71', 'Transtorno neurocognitivo leve'], ['6D72', 'Transtorno amnéstico'], ['6D80', 'Demência devida à doença de Alzheimer'],
  ['6E20', 'Transtornos mentais ou comportamentais associados à gestação, ao parto ou ao puerpério, sem sintomas psicóticos'],
  ['QD85', 'Síndrome de esgotamento profissional (burnout)'], ['HA60', 'Incongruência de gênero na adolescência ou na idade adulta'],
];

// Formatos aceitos ao digitar um código fora da lista
export const valid10 = (c) => /^[A-Z]\d{2}(\.\d{1,2})?$/.test(c);
export const valid11 = (c) => /^[0-9A-Z]{4}(\.[0-9A-Z]{1,2})?$/.test(c) && /\d/.test(c) && /[A-Z]/.test(c);
const name10 = new Map(CID10); const name11 = new Map(CID11);
export const nameOf = (kind, code) => (kind === 'cid10' ? name10 : name11).get(code) || '';

// Lista vinda do formulário ("F41.1, F32.1" ou vários campos) → códigos válidos, sem repetir
export function parseCodes(v, kind) {
  const ok = kind === 'cid10' ? valid10 : valid11;
  const raw = [].concat(v || []).join(',').toUpperCase().split(/[\s,;]+/).map((c) => c.replace(/[^0-9A-Z.]/g, '')).filter(Boolean);
  return [...new Set(raw.filter(ok))].slice(0, 12);
}
